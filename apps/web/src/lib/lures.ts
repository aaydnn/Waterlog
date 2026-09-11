import type { Lure } from '@waterlog/schema'
import { apiClient } from './api-client'
import { getActiveUserId } from './auth/active-user'
import type { WaterlogDb } from './db'

/** Every read is scoped to one angler. The cache is a mirror of somebody's private tackle box,
 * and "whoever is looking" is not the same question as "whose rows are these" — a second
 * account signing in on the same phone used to be shown the first one's lures. Rows with no
 * recorded owner (pre-v4 cache) are nobody's and are never returned; the v4 upgrade deletes
 * them, and this filter means a stale one still can't surface. */
export async function cachedLures(db: WaterlogDb, userId: string | null = getActiveUserId()): Promise<Lure[]> {
  if (!userId) return []
  return db.lures.where('user_id').equals(userId).toArray()
}

/** Refreshes the local lure cache from the server; falls back to whatever's cached when offline
 * (packet principle 5). Always returns what's available locally after attempting the refresh. */
export async function syncLures(db: WaterlogDb, userId: string | null = getActiveUserId()): Promise<Lure[]> {
  if (!userId) return []
  try {
    const { lures } = await apiClient.listLures()
    // The refresh replaces this angler's slice of the cache rather than merging into it, so a
    // lure they deleted stops coming back. Other anglers' rows are never touched.
    await db.transaction('rw', db.lures, async () => {
      const served = new Set(lures.map((l) => l.id))
      const cached = await db.lures.where('user_id').equals(userId).primaryKeys()
      await db.lures.bulkDelete(cached.filter((id) => !served.has(id)))
      await db.lures.bulkPut(lures)
    })
  } catch {
    // offline or the API is down — serve whatever's cached
  }
  return cachedLures(db, userId)
}

/** Quick-add from the capture flow's lure picker. Requires connectivity — lure creation isn't
 * offline-queued like trips/catches, since a picker needs the server-assigned id to select it. */
export async function createLure(db: WaterlogDb, name: string): Promise<Lure> {
  const { lure } = await apiClient.createLure({ name })
  await db.lures.put(lure)
  return lure
}
