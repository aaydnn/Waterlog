import type { Trip } from '@waterlog/schema'
import { tripSchema } from '@waterlog/schema'
import { z } from 'zod'
import { newId } from './ids'

export const tripCreateInput = tripSchema
  .omit({ id: true, user_id: true, created_at: true, updated_at: true, deleted_at: true, client_id: true })
  .extend({ client_id: z.string().min(1) })
export type TripCreateInput = z.infer<typeof tripCreateInput>

const TRIP_COLUMNS =
  'id, user_id, water_body_id, started_at, ended_at, auto_created, planned, notes, created_at, updated_at, deleted_at, client_id'

/** Idempotent by client_id: INSERT ... ON CONFLICT DO NOTHING, then SELECT the canonical row
 * (ADR-0003) — server always assigns id, replaying a batch twice never duplicates. */
export async function upsertTripByClientId(
  db: D1Database,
  userId: string,
  input: TripCreateInput,
): Promise<Trip> {
  const now = Date.now()
  await db
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
    .prepare(`SELECT ${TRIP_COLUMNS} FROM trips WHERE client_id = ?`)
    .bind(input.client_id)
    .first<Trip>()
  if (!row) throw new Error(`trip upsert did not produce a row for client_id ${input.client_id}`)
  return row
}

/** F2: a catch synced with no resolvable trip gets a synthetic 1h trip centered on its
 * timestamp, same as the client would create locally when logging without an active trip. */
export async function createOrphanTrip(db: D1Database, userId: string, caughtAt: number): Promise<Trip> {
  const now = Date.now()
  const trip: Trip = {
    id: newId(),
    user_id: userId,
    water_body_id: null,
    started_at: caughtAt,
    ended_at: caughtAt + 60 * 60 * 1000,
    auto_created: 1,
    planned: 0,
    notes: null,
    client_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
  await db
    .prepare(`INSERT INTO trips (${TRIP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
    .bind(
      trip.id,
      trip.user_id,
      trip.water_body_id,
      trip.started_at,
      trip.ended_at,
      trip.auto_created,
      trip.planned,
      trip.notes,
      trip.created_at,
      trip.updated_at,
    )
    .run()
  return trip
}

export async function getTripById(db: D1Database, userId: string, id: string): Promise<Trip | null> {
  return db
    .prepare(`SELECT ${TRIP_COLUMNS} FROM trips WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .bind(id, userId)
    .first<Trip>()
}
