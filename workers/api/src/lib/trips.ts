import type { Trip } from '@waterlog/schema'
import { tripSchema } from '@waterlog/schema'
import { z } from 'zod'
import { MAX_TRIP_HOUR_BUCKETS } from './hour-buckets'
import { newId } from './ids'
import type { UpsertResult } from './upsert-result'

const HOUR_MS = 60 * 60 * 1000

/** Epoch-ms floor for any angler-supplied timestamp: before this it is a bug, not a memory. */
export const TIMESTAMP_FLOOR_MS = Date.UTC(2000, 0, 1)
/** Clock skew we tolerate ahead of server time — a device with a wrong date still syncs. */
export const FUTURE_SKEW_MS = 24 * HOUR_MS
/**
 * Longest single trip we record. The packet has no stated maximum (§04 F2 only auto-closes a
 * trip after 6h idle), so this is a deliberate ceiling: see docs/adr/0012. It is what bounds
 * enrichment work per trip — every hour of every trip gets a `conditions` row, so an
 * unvalidated `started_at` a year back once produced 8,760 of them from one PATCH.
 */
export const MAX_TRIP_DURATION_MS = MAX_TRIP_HOUR_BUCKETS * HOUR_MS

/** Null when the timestamp is plausible, otherwise the reason it isn't (shown to the client). */
export function validateTimestamp(field: string, value: number, now: number = Date.now()): string | null {
  if (!Number.isFinite(value)) return `${field} is not a valid timestamp`
  if (value < TIMESTAMP_FLOOR_MS) return `${field} is before 2000-01-01`
  if (value > now + FUTURE_SKEW_MS) return `${field} is more than 24h in the future`
  return null
}

/**
 * Shared by the sync batch and the end-trip route so a trip can't enter the system through
 * whichever door is less guarded. Returns null when the times are usable, otherwise the message
 * to report.
 *
 * These are the genuine-bug cases only — a timestamp that is not a timestamp, one from before
 * the product existed, one from the future, an end before its own start. Length is *not* one of
 * them: see `clampTripEnd`.
 */
export function validateTripTimes(
  startedAt: number,
  endedAt: number | null | undefined,
  now: number = Date.now(),
): string | null {
  const startProblem = validateTimestamp('started_at', startedAt, now)
  if (startProblem) return startProblem
  if (endedAt === null || endedAt === undefined) return null

  const endProblem = validateTimestamp('ended_at', endedAt, now)
  if (endProblem) return endProblem
  if (endedAt < startedAt) return 'ended_at is before started_at'
  return null
}

/**
 * Bounds a trip's length instead of refusing it: an over-long trip is clamped to
 * `started_at + MAX_TRIP_DURATION_MS` and the clamped value is what gets persisted and returned,
 * so the client mirrors it.
 *
 * Rejecting would strand data with no client recovery path. An angler who forgot to close
 * Tuesday's trip taps "End trip" on Thursday and the client sends `Date.now()`; a 400 there
 * leaves the trip open forever while the queued end retries. Worse in a batch: a rejected trip
 * takes every catch that references it by client_id down with it ("trip_id not found"), and the
 * client has nothing to correct. A trip nobody closed was never 48 hours of fishing, so cutting
 * it at the ceiling is both the honest record and the bounded one — `computeHourBuckets` keeps
 * its own clamp as a backstop for rows written before this existed.
 *
 * Call only after `validateTripTimes` has passed; it assumes `endedAt >= startedAt`.
 */
export function clampTripEnd(startedAt: number, endedAt: number | null | undefined): number | null {
  if (endedAt === null || endedAt === undefined) return null
  return Math.min(endedAt, startedAt + MAX_TRIP_DURATION_MS)
}

export const tripCreateInput = tripSchema
  .omit({ id: true, user_id: true, created_at: true, updated_at: true, deleted_at: true, client_id: true })
  // water_temp_c defaults rather than being required: it is optional data an angler may never
  // record, and already-deployed clients don't send the field at all.
  .extend({ client_id: z.string().min(1), water_temp_c: z.number().nullish().default(null) })
export type TripCreateInput = z.infer<typeof tripCreateInput>

const TRIP_COLUMNS =
  'id, user_id, water_body_id, started_at, ended_at, auto_created, planned, notes, water_temp_c, created_at, updated_at, deleted_at, client_id'

/** Idempotent by client_id: INSERT ... ON CONFLICT DO NOTHING, then SELECT the canonical row
 * (ADR-0003) — server always assigns id, replaying a batch twice never duplicates. `isNew`
 * reflects D1's reported change count, so callers can enqueue side effects (enrichment) exactly
 * once per row, never on a replay. */
export async function upsertTripByClientId(
  db: D1Database,
  userId: string,
  input: TripCreateInput,
): Promise<UpsertResult<Trip>> {
  const now = Date.now()
  const result = await db
    .prepare(
      `INSERT INTO trips (${TRIP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(client_id) DO NOTHING`,
    )
    .bind(
      newId(),
      userId,
      input.water_body_id,
      input.started_at,
      input.ended_at,
      input.auto_created,
      input.planned,
      input.notes,
      input.water_temp_c,
      now,
      now,
      input.client_id,
    )
    .run()

  const row = await db
    .prepare(`SELECT ${TRIP_COLUMNS} FROM trips WHERE client_id = ? AND user_id = ?`)
    .bind(input.client_id, userId)
    .first<Trip>()
  if (!row) throw new Error(`trip upsert did not produce a row for client_id ${input.client_id}`)
  return { row, isNew: result.meta.changes > 0 }
}

/** F2: a catch synced with no resolvable trip gets a synthetic 1h trip centered on its
 * timestamp, same as the client would create locally when logging without an active trip.
 * Keyed off a deterministic client_id derived from the catch's own client_id so replaying the
 * same sync batch resolves to the same orphan trip instead of minting a new one each time. */
export async function upsertOrphanTrip(
  db: D1Database,
  userId: string,
  catchClientId: string,
  caughtAt: number,
): Promise<UpsertResult<Trip>> {
  return upsertTripByClientId(db, userId, {
    client_id: `orphan:${catchClientId}`,
    water_body_id: null,
    started_at: caughtAt,
    ended_at: caughtAt + 60 * 60 * 1000,
    auto_created: 1,
    planned: 0,
    notes: null,
    water_temp_c: null,
  })
}

export async function getTripById(db: D1Database, userId: string, id: string): Promise<Trip | null> {
  return db
    .prepare(`SELECT ${TRIP_COLUMNS} FROM trips WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .bind(id, userId)
    .first<Trip>()
}

/** Idempotent by construction (ADR-0003): only ends a trip that's still open, so replaying this
 * call never overwrites a real end time with a stale one. Returns null when the trip doesn't
 * exist or isn't owned by this user; returns the (already-ended) trip unchanged on replay, with
 * `isNew: false` so callers don't re-enqueue trip-hour enrichment for it. */
export async function endTrip(
  db: D1Database,
  userId: string,
  id: string,
  endedAt: number,
  waterTempC: number | null = null,
): Promise<UpsertResult<Trip> | null> {
  const result = await db
    .prepare('UPDATE trips SET ended_at = ?, updated_at = ?, water_temp_c = COALESCE(?, water_temp_c) WHERE id = ? AND user_id = ? AND ended_at IS NULL')
    .bind(endedAt, Date.now(), waterTempC, id, userId)
    .run()
  const row = await getTripById(db, userId, id)
  if (!row) return null
  return { row, isNew: result.meta.changes > 0 }
}
