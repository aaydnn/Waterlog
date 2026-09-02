import type { Catch, Trip } from '@waterlog/schema'
import { ulid } from 'ulid'
import { apiClient } from '../api-client'
import type { LocalCatch, LocalTrip, WaterlogDb } from '../db'
import { getDb } from '../db'

// Platform seam (ADR-0001): the sync engine has a web implementation and,
// later, a Capacitor-native implementation behind this same interface.
// Feature code imports the interface, never a concrete implementation.

export type TripDraft = Omit<Trip, 'id' | 'user_id' | 'created_at' | 'updated_at' | 'deleted_at' | 'client_id'>
export type CatchDraft = Omit<
  Catch,
  'id' | 'user_id' | 'created_at' | 'updated_at' | 'deleted_at' | 'client_id' | 'enrich_status' | 'trip_id'
> & {
  /** A pending trip's `local_id` from enqueueTrip(), an already-synced trip's server id, or
   * null for "no active trip" — the server auto-creates a 1h orphan trip (F2). */
  trip_id: string | null
}

export interface SyncResult {
  pushed: number
  failed: number
}

export interface SyncEngine {
  enqueueTrip(draft: TripDraft): Promise<string>
  enqueueCatch(draft: CatchDraft): Promise<string>
  /** `local_id` from enqueueTrip(). Always applies locally right away; if the trip has already
   * synced, also queues the dedicated end-trip call (ADR-0003 — /api/sync can't apply updates). */
  endTrip(localId: string, endedAt: number): Promise<void>
  flush(): Promise<SyncResult>
}

/** Web implementation: Dexie-backed offline queue, flushed to POST /api/sync (idempotent on
 * client_id, ADR-0003). enqueue* never touches the network — it only writes locally, so capture
 * stays instant and offline-tolerant (packet principle 5). */
export class WebSyncEngine implements SyncEngine {
  constructor(private readonly db: WaterlogDb = getDb()) {}

  async enqueueTrip(draft: TripDraft): Promise<string> {
    const row: LocalTrip = { ...draft, local_id: crypto.randomUUID(), client_id: ulid(), id: null, synced_at: null }
    await this.db.trips.put(row)
    return row.local_id
  }

  async enqueueCatch(draft: CatchDraft): Promise<string> {
    const row: LocalCatch = { ...draft, local_id: crypto.randomUUID(), client_id: ulid(), id: null, synced_at: null }
    await this.db.catches.put(row)
    return row.local_id
  }

  async endTrip(localId: string, endedAt: number): Promise<void> {
    const trip = await this.db.trips.get(localId)
    if (!trip) throw new Error(`endTrip: no local trip ${localId}`)

    await this.db.trips.update(localId, { ended_at: endedAt })
    if (trip.id) {
      // Already synced — /api/sync only inserts, so the end has to go through the dedicated
      // endpoint. Queue it; flush() drains this alongside the regular batch.
      await this.db.pendingTripEnds.put({ trip_id: trip.id, ended_at: endedAt })
    }
    // else: unsynced — the ended_at just written above rides along in this trip's first
    // INSERT, no separate call needed.
  }

  async flush(): Promise<SyncResult> {
    let pushed = 0
    let failed = 0

    for (const end of await this.db.pendingTripEnds.toArray()) {
      try {
        await apiClient.endTrip(end.trip_id, end.ended_at)
        await this.db.pendingTripEnds.delete(end.trip_id)
        pushed += 1
      } catch {
        failed += 1
      }
    }

    const pendingTrips = await this.db.trips.filter((t) => t.synced_at === null).toArray()
    const pendingCatches = await this.db.catches.filter((c) => c.synced_at === null).toArray()
    if (pendingTrips.length === 0 && pendingCatches.length === 0) return { pushed, failed }

    // A pending catch's trip_id may be another pending trip's local_id (the server hasn't
    // assigned that trip a real id yet) — resolve it to the trip's client_id, the identifier
    // the server can actually match against the trips in this same batch.
    const localIdToClientId = new Map(pendingTrips.map((t) => [t.local_id, t.client_id as string]))
    const resolveTripId = (tripId: string | null): string | undefined =>
      tripId === null ? undefined : (localIdToClientId.get(tripId) ?? tripId)

    let response
    try {
      response = await apiClient.sync({
        trips: pendingTrips.map((t) => ({
          client_id: t.client_id as string,
          water_body_id: t.water_body_id,
          started_at: t.started_at,
          ended_at: t.ended_at,
          auto_created: t.auto_created,
          planned: t.planned,
          notes: t.notes,
        })),
        catches: pendingCatches.map((c) => ({
          client_id: c.client_id as string,
          trip_id: resolveTripId(c.trip_id),
          lure_id: c.lure_id,
          species: c.species,
          caught_at: c.caught_at,
          lat: c.lat,
          lng: c.lng,
          photo_key: c.photo_key,
          length_mm: c.length_mm,
          weight_g: c.weight_g,
          depth_m: c.depth_m,
          released: c.released,
          notes: c.notes,
        })),
      })
    } catch {
      // Offline or the API is down: leave everything queued for the next flush().
      return { pushed, failed: failed + pendingTrips.length + pendingCatches.length }
    }

    const now = Date.now()

    for (const trip of response.trips) {
      const local = pendingTrips.find((t) => t.client_id === trip.client_id)
      if (local) {
        await this.db.trips.update(local.local_id, { id: trip.id, synced_at: now })
      } else {
        // A trip the server created that this device never enqueued (an orphan-catch trip) —
        // mirror it locally so the journal and any catch referencing it can resolve it.
        await this.db.trips.put({ ...trip, local_id: trip.id, synced_at: now })
      }
      pushed += 1
    }

    for (const c of response.catches) {
      const local = pendingCatches.find((row) => row.client_id === c.client_id)
      if (!local) continue
      await this.db.catches.update(local.local_id, { id: c.id, trip_id: c.trip_id, synced_at: now })
      pushed += 1
    }

    return { pushed, failed: failed + response.errors.length }
  }
}
