import type { Lure } from '@waterlog/schema'
import { lureFamilySchema, lureSchema } from '@waterlog/schema'
import { z } from 'zod'
import { newId } from './ids'

export const lureCreateInput = lureSchema
  .omit({ id: true, user_id: true, created_at: true, updated_at: true, deleted_at: true, retired_at: true })
  .extend({
    family: lureFamilySchema.nullable().optional().default(null),
    color: z.string().nullable().optional().default(null),
    cost_cents: z.number().int().nullable().optional().default(null),
  })
export type LureCreateInput = z.infer<typeof lureCreateInput>

const LURE_COLUMNS = 'id, user_id, name, family, color, cost_cents, retired_at, created_at, updated_at, deleted_at'

/** Active (non-retired, non-deleted) lures, most-recently-updated first — feeds the capture
 * flow's lure picker "recents" without needing a separate usage-tracking table. */
export async function listLures(db: D1Database, userId: string): Promise<Lure[]> {
  const { results } = await db
    .prepare(`SELECT ${LURE_COLUMNS} FROM lures WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`)
    .bind(userId)
    .all<Lure>()
  return results
}

/** Ownership check for the capture path, the twin of `waterBodyExists`: a catch may only
 * reference a lure the caller owns. Without it a crafted `lure_id` both mislabels the catch and
 * — through the journal's join — reads back another angler's private lure name.
 *
 * Ownership only, deliberately: unlike a water body, a retired or soft-deleted lure is still the
 * angler's own history, and a catch queued offline before the lure was retired must still sync. */
export async function lureExists(db: D1Database, userId: string, id: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM lures WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<{ ok: number }>()
  return row !== null
}

export async function createLure(db: D1Database, userId: string, input: LureCreateInput): Promise<Lure> {
  const now = Date.now()
  const lure: Lure = {
    id: newId(),
    user_id: userId,
    name: input.name,
    family: input.family,
    color: input.color,
    cost_cents: input.cost_cents,
    retired_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
  await db
    .prepare(`INSERT INTO lures (${LURE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`)
    .bind(lure.id, lure.user_id, lure.name, lure.family, lure.color, lure.cost_cents, lure.created_at, lure.updated_at)
    .run()
  return lure
}
