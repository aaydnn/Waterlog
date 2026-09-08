import type { Catch, Lure, Trip, WaterBody } from '@waterlog/schema'
import Dexie, { type Table } from 'dexie'

// Local mirrors of the server payload shapes (packages/schema Trip/Catch), plus the bookkeeping
// a not-yet-synced record needs. `local_id` is the Dexie primary key and never leaves the
// device; `client_id` is the sync idempotency key (ADR-0003) and is what the server sees; `id`
// is null until the first successful sync assigns it.
type TripFields = Omit<Trip, 'id' | 'user_id' | 'created_at' | 'updated_at' | 'deleted_at' | 'client_id'>
type CatchFields = Omit<
  Catch,
  'id' | 'user_id' | 'created_at' | 'updated_at' | 'deleted_at' | 'client_id' | 'enrich_status' | 'trip_id'
>

export interface LocalTrip extends TripFields {
  local_id: string
  /** null only for a trip the server created (an orphan-catch trip) that this device never
   * enqueued itself. */
  client_id: string | null
  id: string | null
  synced_at: number | null
}

export interface LocalCatch extends CatchFields {
  local_id: string
  client_id: string | null
  id: string | null
  /** A pending trip's `local_id`, an already-synced trip's server `id`, or null for "no active
   * trip" (F2 orphan capture) — resolved to the right wire value at flush time. */
  trip_id: string | null
  synced_at: number | null
}

/** A trip that's already synced (has a server id) and was ended while offline — /api/sync can
 * never apply the end (it only inserts), so the dedicated end-trip call is queued here and
 * retried by the sync engine like any other pending write. */
export interface PendingTripEnd {
  trip_id: string
  ended_at: number
  /** The angler's own reading, in Celsius. null when they did not take one. */
  water_temp_c: number | null
}

export class WaterlogDb extends Dexie {
  trips!: Table<LocalTrip, string>
  catches!: Table<LocalCatch, string>
  lures!: Table<Lure, string>
  waterBodies!: Table<WaterBody, string>
  pendingTripEnds!: Table<PendingTripEnd, string>

  constructor(name = 'waterlog') {
    super(name)
    this.version(1).stores({
      trips: 'local_id, client_id, id, synced_at',
      catches: 'local_id, client_id, id, trip_id, synced_at, caught_at',
      lures: 'id, name',
      pendingTripEnds: 'trip_id',
    })
    // v2: the angler's waters, mirrored so the trip banner can name and rank them offline.
    this.version(2).stores({
      waterBodies: 'id, name',
    })
  }
}

let instance: WaterlogDb | null = null

/** Lazy so importing this module never touches IndexedDB (tests, SSR). */
export function getDb(): WaterlogDb {
  instance ??= new WaterlogDb()
  return instance
}
