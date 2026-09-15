import { getActiveUserId } from '../../lib/auth/active-user'
import type { WaterlogDb } from '../../lib/db'

const RECENTS_COUNT = 6

/** Only the signed-in angler's own catches feed the shelves. The picker is the most-looked-at
 * surface in the app, and "your recents" quietly meaning "this device's recents" is how one
 * angler learns what another has been catching. Catches with no recorded owner (pre-v3 rows)
 * count for nobody — a small loss of convenience on an upgraded device, against showing a
 * stranger's fish. */
async function ownCatchesNewestFirst(db: WaterlogDb, userId: string) {
  return db.catches
    .orderBy('caught_at')
    .reverse()
    .filter((c) => c.user_id === userId)
    .toArray()
}

/** Distinct species from the most recent catches, newest first — the picker's "recents" shelf
 * (F1: "species sheet (6 recents + search)"). */
export async function recentSpecies(
  db: WaterlogDb,
  limit = RECENTS_COUNT,
  userId: string | null = getActiveUserId(),
): Promise<string[]> {
  if (!userId) return []
  const catches = await ownCatchesNewestFirst(db, userId)
  const seen = new Set<string>()
  const result: string[] = []
  for (const c of catches) {
    if (seen.has(c.species)) continue
    seen.add(c.species)
    result.push(c.species)
    if (result.length >= limit) break
  }
  return result
}

/** Distinct lure ids from the most recent catches that used one, newest first. */
export async function recentLureIds(
  db: WaterlogDb,
  limit = RECENTS_COUNT,
  userId: string | null = getActiveUserId(),
): Promise<string[]> {
  if (!userId) return []
  const catches = await ownCatchesNewestFirst(db, userId)
  const seen = new Set<string>()
  const result: string[] = []
  for (const c of catches) {
    if (!c.lure_id || seen.has(c.lure_id)) continue
    seen.add(c.lure_id)
    result.push(c.lure_id)
    if (result.length >= limit) break
  }
  return result
}
