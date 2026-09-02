import type { Catch } from '@waterlog/schema'
import { catchSchema } from '@waterlog/schema'
import { z } from 'zod'
import { newId } from './ids'

export const catchCreateInput = catchSchema
  .omit({
    id: true,
    user_id: true,
    created_at: true,
    updated_at: true,
    deleted_at: true,
    client_id: true,
    enrich_status: true,
    trip_id: true,
  })
  .extend({
    client_id: z.string().min(1),
    // Absent trip_id means "no active trip" — the sync route resolves it to an auto-created one.
    trip_id: z.string().min(1).optional(),
  })
export type CatchCreateInput = z.infer<typeof catchCreateInput>

const CATCH_COLUMNS =
  'id, user_id, trip_id, lure_id, species, caught_at, lat, lng, photo_key, length_mm, weight_g, depth_m, released, notes, client_id, enrich_status, created_at, updated_at, deleted_at'

/** Idempotent by client_id, same idiom as trips (ADR-0003): INSERT ... ON CONFLICT DO NOTHING,
 * then SELECT the canonical row. `tripId` is the already-resolved server trip id. */
export async function upsertCatchByClientId(
  db: D1Database,
  userId: string,
  tripId: string,
  input: CatchCreateInput,
): Promise<Catch> {
  const now = Date.now()
  await db
    .prepare(
      `INSERT INTO catches (${CATCH_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL) ON CONFLICT(client_id) DO NOTHING`,
    )
    .bind(
      newId(),
      userId,
      tripId,
      input.lure_id,
      input.species,
      input.caught_at,
      input.lat,
      input.lng,
      input.photo_key,
      input.length_mm,
      input.weight_g,
      input.depth_m,
      input.released,
      input.notes,
      input.client_id,
      now,
      now,
    )
    .run()

  const row = await db
    .prepare(`SELECT ${CATCH_COLUMNS} FROM catches WHERE client_id = ?`)
    .bind(input.client_id)
    .first<Catch>()
  if (!row) throw new Error(`catch upsert did not produce a row for client_id ${input.client_id}`)
  return row
}
