import type { WaterBody } from '@waterlog/schema'
import { waterBodyKindSchema, waterBodySchema } from '@waterlog/schema'
import { z } from 'zod'
import { newId } from './ids'

export const waterBodyCreateInput = waterBodySchema
  .omit({ id: true, user_id: true, created_at: true, updated_at: true, deleted_at: true })
  .extend({
    name: z.string().min(1),
    kind: waterBodyKindSchema.nullable().optional().default(null),
    centroid_lat: z.number().min(-90).max(90).nullable().optional().default(null),
    centroid_lng: z.number().min(-180).max(180).nullable().optional().default(null),
    // Gauge handles are mapped deliberately, not guessed by the client (ADR-0008): the enrich
    // worker fills usgs_gauge_id in by proximity, and a pool gauge is set by hand.
    usgs_gauge_id: z.string().nullable().optional().default(null),
    nwps_gauge_id: z.string().nullable().optional().default(null),
    is_home: z
      .union([z.literal(0), z.literal(1)])
      .optional()
      .default(0),
  })
export type WaterBodyCreateInput = z.infer<typeof waterBodyCreateInput>

const WATER_BODY_COLUMNS =
  'id, user_id, name, kind, centroid_lat, centroid_lng, usgs_gauge_id, nwps_gauge_id, is_home, created_at, updated_at, deleted_at'

/** The angler's waters, home water first, then alphabetical — a stable order the client can
 * re-sort by distance once it has a GPS fix. */
export async function listWaterBodies(db: D1Database, userId: string): Promise<WaterBody[]> {
  const { results } = await db
    .prepare(
      `SELECT ${WATER_BODY_COLUMNS} FROM water_bodies
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY is_home DESC, name COLLATE NOCASE ASC`,
    )
    .bind(userId)
    .all<WaterBody>()
  return results
}

export async function createWaterBody(
  db: D1Database,
  userId: string,
  input: WaterBodyCreateInput,
): Promise<WaterBody> {
  const now = Date.now()
  const water: WaterBody = {
    id: newId(),
    user_id: userId,
    name: input.name,
    kind: input.kind,
    centroid_lat: input.centroid_lat,
    centroid_lng: input.centroid_lng,
    usgs_gauge_id: input.usgs_gauge_id,
    nwps_gauge_id: input.nwps_gauge_id,
    is_home: input.is_home,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
  await db
    .prepare(`INSERT INTO water_bodies (${WATER_BODY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .bind(
      water.id,
      water.user_id,
      water.name,
      water.kind,
      water.centroid_lat,
      water.centroid_lng,
      water.usgs_gauge_id,
      water.nwps_gauge_id,
      water.is_home,
      water.created_at,
      water.updated_at,
    )
    .run()
  return water
}

/** Ownership check for the sync path: a trip may only reference a water the caller owns. */
export async function waterBodyExists(db: D1Database, userId: string, id: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM water_bodies WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(id, userId)
    .first<{ ok: number }>()
  return row !== null
}
