import type { JournalEntry, JournalPage } from '@waterlog/schema'
import { ApiError, apiClient, type JournalQuery } from '../../lib/api-client'
import { getActiveUserId } from '../../lib/auth/active-user'
import type { WaterlogDb } from '../../lib/db'

export interface JournalResult extends JournalPage {
  /** True when the server couldn't be reached and this is the device's own copy: everything
   * logged here, but nothing logged on another device and nothing enriched yet. */
  offline: boolean
}

/** Matches the server's filters against the Dexie mirror. Kept deliberately close to
 * `listJournal` in workers/api so the two views of the same journal don't disagree on what a
 * filter means. */
export async function localJournal(db: WaterlogDb, query: JournalQuery): Promise<JournalEntry[]> {
  // Scoped like the server's: another angler who signed in on this device must not see these
  // rows offline either. A null stamp predates the v3 store and belongs to whoever is here.
  const userId = getActiveUserId()
  const mine = (row: { user_id: string | null }): boolean => row.user_id === null || row.user_id === userId
  const [catches, trips, waters, lures] = await Promise.all([
    db.catches.filter(mine).toArray(),
    db.trips.filter(mine).toArray(),
    db.waterBodies.toArray(),
    db.lures.toArray(),
  ])
  const tripByRef = new Map(trips.flatMap((t) => (t.id ? [[t.id, t] as const] : [[t.local_id, t] as const])))
  const waterById = new Map(waters.map((w) => [w.id, w]))
  const lureById = new Map(lures.map((l) => [l.id, l]))

  return catches
    .map((c) => {
      const trip = c.trip_id ? tripByRef.get(c.trip_id) : undefined
      const water = trip?.water_body_id ? waterById.get(trip.water_body_id) : undefined
      const lure = c.lure_id ? lureById.get(c.lure_id) : undefined
      return {
        // A catch that hasn't synced has no server id yet; its local_id is what the detail view
        // would need, and the UI marks it as pending rather than pretending it's on the server.
        id: c.id ?? c.local_id,
        caught_at: c.caught_at,
        species: c.species,
        photo_key: c.photo_key,
        length_mm: c.length_mm,
        weight_g: c.weight_g,
        released: c.released,
        notes: c.notes,
        enrich_status: 'pending' as const,
        lure_id: c.lure_id,
        lure_name: lure?.name ?? null,
        trip_id: trip?.id ?? c.trip_id ?? '',
        water_body_id: trip?.water_body_id ?? null,
        water_body_name: water?.name ?? null,
      }
    })
    .filter((e) => {
      if (query.species && e.species !== query.species) return false
      if (query.water_body_id && e.water_body_id !== query.water_body_id) return false
      if (query.lure_id && e.lure_id !== query.lure_id) return false
      if (query.from !== undefined && e.caught_at < query.from) return false
      if (query.to !== undefined && e.caught_at > query.to) return false
      return true
    })
    .sort((a, b) => b.caught_at - a.caught_at || (a.id < b.id ? 1 : -1))
}

/** Server first, device second. The journal is the angler's record of their own fishing — it
 * has to render something in a cove with no signal, not an error. */
export async function fetchJournal(db: WaterlogDb, query: JournalQuery): Promise<JournalResult> {
  try {
    const page = await apiClient.journal(query)
    return { ...page, offline: false }
  } catch (error) {
    // A 401 is not a bad connection. The app-level handler is already switching to the sign-in
    // screen; saying "offline" here would be the same lie the capture toast used to tell.
    const signedOut = error instanceof ApiError && error.status === 401
    return { entries: await localJournal(db, query), next_cursor: null, offline: !signedOut }
  }
}

/** The photo URL for an entry, or null when the catch has none. Photos are served through the
 * API (they're private R2 objects), never straight from a bucket URL. */
export function photoUrl(photoKey: string | null): string | null {
  return photoKey ? `/api/photos/${photoKey}` : null
}
