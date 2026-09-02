import type { LocalTrip, WaterlogDb } from '../../lib/db'
import type { SyncEngine, TripDraft } from '../../lib/sync/sync-engine'

/** The most recently started trip that hasn't been ended yet, or null (F2: start/stop wrapper). */
export async function getActiveTrip(db: WaterlogDb): Promise<LocalTrip | null> {
  const open = await db.trips.filter((t) => t.ended_at === null).toArray()
  if (open.length === 0) return null
  return open.reduce((latest, t) => (t.started_at > latest.started_at ? t : latest))
}

/** No-ops if a trip is already active, so a double tap can never open two trips. */
export async function startTrip(engine: SyncEngine, db: WaterlogDb): Promise<LocalTrip> {
  const existing = await getActiveTrip(db)
  if (existing) return existing

  const draft: TripDraft = {
    water_body_id: null,
    started_at: Date.now(),
    ended_at: null,
    auto_created: 0,
    planned: 0,
    notes: null,
  }
  const localId = await engine.enqueueTrip(draft)
  const trip = await db.trips.get(localId)
  if (!trip) throw new Error('startTrip: just-enqueued trip is missing locally')
  return trip
}

/** No-ops if there's no active trip. */
export async function endActiveTrip(engine: SyncEngine, db: WaterlogDb): Promise<void> {
  const active = await getActiveTrip(db)
  if (!active) return
  await engine.endTrip(active.local_id, Date.now())
}

/** The identifier a catch should reference for "the current trip": the server id once synced,
 * otherwise the pending trip's local_id (resolved to its client_id at flush time). */
export function tripReferenceFor(trip: LocalTrip | null): string | null {
  if (!trip) return null
  return trip.id ?? trip.local_id
}
