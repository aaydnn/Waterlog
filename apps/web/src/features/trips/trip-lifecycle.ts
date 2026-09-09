import { getActiveUserId } from '../../lib/auth/active-user'
import type { LocalTrip, WaterlogDb } from '../../lib/db'
import type { SyncEngine, TripDraft } from '../../lib/sync/sync-engine'

/** The most recently started trip that hasn't been ended yet, or null (F2: start/stop wrapper). */
export async function getActiveTrip(db: WaterlogDb): Promise<LocalTrip | null> {
  // Never resume a trip another angler left open on this device.
  const userId = getActiveUserId()
  const open = await db.trips
    .filter((t) => t.ended_at === null && (t.user_id === null || t.user_id === userId))
    .toArray()
  if (open.length === 0) return null
  return open.reduce((latest, t) => (t.started_at > latest.started_at ? t : latest))
}

/** No-ops if a trip is already active, so a double tap can never open two trips. */
export async function startTrip(
  engine: SyncEngine,
  db: WaterlogDb,
  waterBodyId: string | null = null,
): Promise<LocalTrip> {
  const existing = await getActiveTrip(db)
  if (existing) return existing

  const draft: TripDraft = {
    water_body_id: waterBodyId,
    started_at: Date.now(),
    ended_at: null,
    auto_created: 0,
    planned: 0,
    notes: null,
    water_temp_c: null,
  }
  const localId = await engine.enqueueTrip(draft)
  const trip = await db.trips.get(localId)
  if (!trip) throw new Error('startTrip: just-enqueued trip is missing locally')
  return trip
}

/** No-ops if there's no active trip. */
export async function endActiveTrip(
  engine: SyncEngine,
  db: WaterlogDb,
  waterTempC: number | null = null,
): Promise<void> {
  const active = await getActiveTrip(db)
  if (!active) return
  await engine.endTrip(active.local_id, Date.now(), waterTempC)
}

/** The identifier a catch should reference for "the current trip": the server id once synced,
 * otherwise the pending trip's local_id (resolved to its client_id at flush time). */
export function tripReferenceFor(trip: LocalTrip | null): string | null {
  if (!trip) return null
  return trip.id ?? trip.local_id
}
