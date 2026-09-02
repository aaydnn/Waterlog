import type { Lure } from '@waterlog/schema'
import { apiClient } from './api-client'
import type { WaterlogDb } from './db'

/** Refreshes the local lure cache from the server; falls back to whatever's cached when offline
 * (packet principle 5). Always returns what's available locally after attempting the refresh. */
export async function syncLures(db: WaterlogDb): Promise<Lure[]> {
  try {
    const { lures } = await apiClient.listLures()
    await db.lures.bulkPut(lures)
  } catch {
    // offline or the API is down — serve whatever's cached
  }
  return db.lures.toArray()
}

/** Quick-add from the capture flow's lure picker. Requires connectivity — lure creation isn't
 * offline-queued like trips/catches, since a picker needs the server-assigned id to select it. */
export async function createLure(db: WaterlogDb, name: string): Promise<Lure> {
  const { lure } = await apiClient.createLure({ name })
  await db.lures.put(lure)
  return lure
}
