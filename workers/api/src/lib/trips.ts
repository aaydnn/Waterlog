import type { Trip } from '@waterlog/schema'
import { effortSourceSchema, tripSchema } from '@waterlog/schema'
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

/**
 * Floor on an auto-closed trip's recorded duration, matching `upsertOrphanTrip`'s synthetic hour
 * and the client's `MIN_TRIP_MS`. A skunked trip's last activity is its own start, and ending it
 * there would record zero hours — which would quietly delete the skunk from the exposure
 * denominator every rate in packet §08 divides by. That is the one thing this product must
 * never do.
 */
export const MIN_TRIP_MS = HOUR_MS

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
  .omit({
    id: true,
    user_id: true,
    created_at: true,
    updated_at: true,
    deleted_at: true,
    client_id: true,
    // Server-owned: the post-trip lesson is written by the pattern queue consumer from engine
    // output (ADR-0017), so a client can never set it.
    lesson_json: true,
  })
  // water_temp_c defaults rather than being required: it is optional data an angler may never
  // record, and already-deployed clients don't send the field at all. effort_source and
  // target_species default for the same reason — they arrived with ADR-0017, and a client that
  // predates them must keep syncing. 'manual' matches the column default, and is the honest
  // answer for a trip whose clock we cannot vouch for.
  .extend({
    client_id: z.string().min(1),
    water_temp_c: z.number().nullish().default(null),
    effort_source: effortSourceSchema.default('manual'),
    target_species: z.string().nullish().default(null),
  })
export type TripCreateInput = z.infer<typeof tripCreateInput>

const TRIP_COLUMNS =
  'id, user_id, water_body_id, started_at, ended_at, auto_created, planned, notes, water_temp_c, created_at, updated_at, deleted_at, client_id, effort_source, target_species, lesson_json'

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
      // Trailing NULL is lesson_json: a trip has no lesson until the engine has run on it.
      `INSERT INTO trips (${TRIP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL) ON CONFLICT(client_id) DO NOTHING`,
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
      input.effort_source,
      input.target_species,
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
    // Nothing timed this hour — it was inferred from a catch that arrived without a trip. The
    // engine scores its exposure down accordingly (ADR-0017).
    effort_source: 'reconstructed',
    target_species: null,
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
/**
 * When a trip nobody closed should be recorded as having ended: the last thing we know happened
 * on it, floored at an hour. Not the moment we noticed — a trip left running for two days did
 * not gain forty-eight hours of fishing, and every pattern in §08 divides by those hours.
 *
 * Same rule as the client's `suggestedEndAt`, deliberately: whichever side closes a forgotten
 * trip, it gets recorded the same length.
 */
export function staleTripEndAt(startedAt: number, lastCatchAt: number | null): number {
  return Math.max(startedAt + MIN_TRIP_MS, lastCatchAt ?? startedAt)
}

/**
 * Backstop for trips left open past the point where they could still be real.
 *
 * Deliberately *not* the 6h idle rule from packet §04 F2. Six hours of nothing is exactly what a
 * hard skunk looks like, and closing that trip mid-outing would cut the angler's hours to one
 * and corrupt the denominator in the direction that flatters them. So the idle case stays on the
 * client, where the banner asks and "Still fishing" can answer (`features/trips/auto-close.ts`).
 *
 * Past `MAX_TRIP_DURATION_MS` no such ambiguity is left: a trip is clamped to that ceiling on
 * every path that can close it (ADR-0012), so one still open beyond it cannot legitimately
 * accrue another minute. Closing it costs nothing that was real and stops it from either sitting
 * open forever — contributing no hours while its catches do count — or dumping two fictional
 * days into the denominator whenever it is finally closed by hand.
 *
 * Scoped to one angler and idempotent: `endTrip` only touches a trip that is still open, so a
 * second sweep over the same rows changes nothing. Returns the trips it closed so the caller can
 * enqueue their hour-bucket enrichment, which is what turns them into exposure rows.
 */
export async function autoCloseStaleTrips(
  db: D1Database,
  userId: string,
  now: number = Date.now(),
): Promise<Trip[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.started_at, MAX(c.caught_at) AS last_catch_at
       FROM trips t
       LEFT JOIN catches c ON c.trip_id = t.id AND c.user_id = t.user_id AND c.deleted_at IS NULL
       WHERE t.user_id = ? AND t.ended_at IS NULL AND t.deleted_at IS NULL AND t.started_at < ?
       GROUP BY t.id`,
    )
    .bind(userId, now - MAX_TRIP_DURATION_MS)
    .all<{ id: string; started_at: number; last_catch_at: number | null }>()

  const closed: Trip[] = []
  for (const stale of results) {
    const endedAt = clampTripEnd(stale.started_at, staleTripEndAt(stale.started_at, stale.last_catch_at))
    if (endedAt === null) continue
    const result = await endTrip(db, userId, stale.id, endedAt)
    if (result?.isNew) closed.push(result.row)
  }
  if (closed.length > 0) console.warn('trips: auto-closed', closed.length, 'stale trips for user', userId)
  return closed
}

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
