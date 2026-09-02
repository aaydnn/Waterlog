import type { Catch, Trip } from '@waterlog/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WaterlogDb } from '../db'
import type { CatchDraft, TripDraft } from './sync-engine'
import { WebSyncEngine } from './sync-engine'

let dbCounter = 0
function freshDb(): WaterlogDb {
  dbCounter += 1
  return new WaterlogDb(`test-waterlog-${dbCounter}`)
}

function tripDraft(overrides: Partial<TripDraft> = {}): TripDraft {
  return {
    water_body_id: null,
    started_at: 1_780_000_000_000,
    ended_at: null,
    auto_created: 0,
    planned: 1,
    notes: null,
    ...overrides,
  }
}

function catchDraft(overrides: Partial<CatchDraft> = {}): CatchDraft {
  return {
    trip_id: null,
    lure_id: null,
    species: 'largemouth_bass',
    caught_at: 1_780_000_100_000,
    lat: null,
    lng: null,
    photo_key: null,
    length_mm: null,
    weight_g: null,
    depth_m: null,
    released: null,
    notes: null,
    ...overrides,
  }
}

function serverTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'srv_trip',
    user_id: 'usr_1',
    water_body_id: null,
    started_at: 1_780_000_000_000,
    ended_at: null,
    auto_created: 0,
    planned: 1,
    notes: null,
    client_id: null,
    created_at: 1_780_000_000_000,
    updated_at: 1_780_000_000_000,
    deleted_at: null,
    ...overrides,
  }
}

function serverCatch(overrides: Partial<Catch> = {}): Catch {
  return {
    id: 'srv_catch',
    user_id: 'usr_1',
    trip_id: 'srv_trip',
    lure_id: null,
    species: 'largemouth_bass',
    caught_at: 1_780_000_100_000,
    lat: null,
    lng: null,
    photo_key: null,
    length_mm: null,
    weight_g: null,
    depth_m: null,
    released: null,
    notes: null,
    client_id: null,
    enrich_status: 'pending',
    created_at: 1_780_000_100_000,
    updated_at: 1_780_000_100_000,
    deleted_at: null,
    ...overrides,
  }
}

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok, status, json: async () => body })
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WebSyncEngine.enqueueTrip / enqueueCatch', () => {
  it('writes a pending row locally without touching the network', async () => {
    const engine = new WebSyncEngine(freshDb())
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const localId = await engine.enqueueTrip(tripDraft())
    expect(typeof localId).toBe('string')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('WebSyncEngine.flush', () => {
  it('is a no-op when nothing is queued', async () => {
    const engine = new WebSyncEngine(freshDb())
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    expect(await engine.flush()).toEqual({ pushed: 0, failed: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves a same-batch catch trip_id to the pending trip client_id, and updates local rows on success', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db)

    const tripLocalId = await engine.enqueueTrip(tripDraft())
    const catchLocalId = await engine.enqueueCatch(catchDraft({ trip_id: tripLocalId }))
    const pendingTrip = await db.trips.get(tripLocalId)
    const pendingCatch = await db.catches.get(catchLocalId)

    const fetchSpy = mockFetchOnce({
      trips: [serverTrip({ id: 'srv_trip_1', client_id: pendingTrip!.client_id })],
      catches: [serverCatch({ id: 'srv_catch_1', trip_id: 'srv_trip_1', client_id: pendingCatch!.client_id })],
      errors: [],
    })

    const result = await engine.flush()
    expect(result).toEqual({ pushed: 2, failed: 0 })

    // The wire payload referenced the trip's client_id, not the local-only local_id.
    const sentBody = JSON.parse(fetchSpy.mock.calls[0]![1].body as string)
    expect(sentBody.catches[0].trip_id).toBe(pendingTrip!.client_id)

    const updatedTrip = await db.trips.get(tripLocalId)
    expect(updatedTrip!.id).toBe('srv_trip_1')
    expect(updatedTrip!.synced_at).not.toBeNull()

    const updatedCatch = await db.catches.get(catchLocalId)
    expect(updatedCatch!.id).toBe('srv_catch_1')
    expect(updatedCatch!.trip_id).toBe('srv_trip_1')
    expect(updatedCatch!.synced_at).not.toBeNull()
  })

  it('omits trip_id on the wire for an orphan catch and mirrors the server-created trip locally', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    const catchLocalId = await engine.enqueueCatch(catchDraft({ trip_id: null }))
    const pendingCatch = await db.catches.get(catchLocalId)

    const fetchSpy = mockFetchOnce({
      trips: [serverTrip({ id: 'srv_orphan_trip', client_id: null, auto_created: 1 })],
      catches: [serverCatch({ id: 'srv_catch_2', trip_id: 'srv_orphan_trip', client_id: pendingCatch!.client_id })],
      errors: [],
    })

    const result = await engine.flush()
    expect(result).toEqual({ pushed: 2, failed: 0 })

    const sentBody = JSON.parse(fetchSpy.mock.calls[0]![1].body as string)
    expect('trip_id' in sentBody.catches[0]).toBe(false)

    const mirroredTrip = await db.trips.get('srv_orphan_trip')
    expect(mirroredTrip).toBeDefined()
    expect(mirroredTrip!.auto_created).toBe(1)

    const updatedCatch = await db.catches.get(catchLocalId)
    expect(updatedCatch!.trip_id).toBe('srv_orphan_trip')
  })

  it('leaves an errored catch queued for retry and reports it as failed', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    const catchLocalId = await engine.enqueueCatch(catchDraft({ trip_id: 'some_unknown_server_trip' }))
    const pendingCatch = await db.catches.get(catchLocalId)

    mockFetchOnce({
      trips: [],
      catches: [],
      errors: [{ client_id: pendingCatch!.client_id, message: 'trip_id some_unknown_server_trip not found' }],
    })

    const result = await engine.flush()
    expect(result).toEqual({ pushed: 0, failed: 1 })

    const stillPending = await db.catches.get(catchLocalId)
    expect(stillPending!.synced_at).toBeNull()
  })

  it('treats a network failure as nothing synced, leaving records queued', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    await engine.enqueueTrip(tripDraft())
    await engine.enqueueCatch(catchDraft())
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('offline')),
    )

    expect(await engine.flush()).toEqual({ pushed: 0, failed: 2 })
  })

  it('replaying flush after a successful sync is a no-op (nothing left pending)', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    const tripLocalId = await engine.enqueueTrip(tripDraft())
    const pendingTrip = await db.trips.get(tripLocalId)

    mockFetchOnce({
      trips: [serverTrip({ id: 'srv_trip_x', client_id: pendingTrip!.client_id })],
      catches: [],
      errors: [],
    })
    await engine.flush()

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await engine.flush()).toEqual({ pushed: 0, failed: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
