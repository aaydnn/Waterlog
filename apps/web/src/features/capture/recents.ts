import type { WaterlogDb } from '../../lib/db'

const RECENTS_COUNT = 6

/** Distinct species from the most recent catches, newest first — the picker's "recents" shelf
 * (F1: "species sheet (6 recents + search)"). */
export async function recentSpecies(db: WaterlogDb, limit = RECENTS_COUNT): Promise<string[]> {
  const catches = await db.catches.orderBy('caught_at').reverse().toArray()
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
export async function recentLureIds(db: WaterlogDb, limit = RECENTS_COUNT): Promise<string[]> {
  const catches = await db.catches.orderBy('caught_at').reverse().toArray()
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
