import type { Trip } from '@waterlog/schema'
import { tripSchema } from '@waterlog/schema'
import { z } from 'zod'
import { newId } from './ids'
import type { UpsertResult } from './upsert-result'

export const tripCreateInput = tripSchema
  .omit({ id: true, user_id: true, created_at: true, updated_at: true, deleted_at: true, client_id: true })
  .extend({ client_id: z.string().min(1) })
export type TripCreateInput = z.infer<typeof tripCreateInput>

const TRIP_COLUMNS =
  'id, user_id, water_body_id, started_at, ended_at, auto_created, planned, notes, created_at, updated_at, deleted_at, client_id'

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
      `INSERT INTO trips (${TRIP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(client_id) DO NOTHING`,
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
): Promise<UpsertResult<Trip> | null> {
  const result = await db
    .prepare('UPDATE trips SET ended_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND ended_at IS NULL')
    .bind(endedAt, Date.now(), id, userId)
    .run()
  const row = await getTripById(db, userId, id)
  if (!row) return null
  return { row, isNew: result.meta.changes > 0 }
}
