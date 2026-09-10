import type { Catch, Trip } from '@waterlog/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSessionMismatchHandler } from '../api-client'
import { setActiveUserId } from '../auth/active-user'
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
    water_temp_c: null,
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
    water_temp_c: null,
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

  it("sends the angler's water temperature on a trip that has never synced", async () => {
    // A trip started and ended offline reaches the server through /api/sync, not the trip-end
    // endpoint, so the reading has to ride along in this payload. Leaving it out silently
    // dropped the measurement for every trip ended before its first sync.
    const db = freshDb()
    const engine = new WebSyncEngine(db)

    const tripLocalId = await engine.enqueueTrip(tripDraft())
    await engine.endTrip(tripLocalId, 1_780_003_600_000, 18.3)
    const pendingTrip = await db.trips.get(tripLocalId)
    expect(pendingTrip!.id).toBeNull() // never synced, so no dedicated end call was queued
    expect(await db.pendingTripEnds.count()).toBe(0)

    const fetchSpy = mockFetchOnce({
      trips: [serverTrip({ id: 'srv_trip_temp', client_id: pendingTrip!.client_id })],
      catches: [],
      errors: [],
    })
    await engine.flush()

    const sentBody = JSON.parse(fetchSpy.mock.calls[0]![1].body as string)
    expect(sentBody.trips[0].water_temp_c).toBe(18.3)
    expect(sentBody.trips[0].ended_at).toBe(1_780_003_600_000)
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

describe('WebSyncEngine.endTrip', () => {
  it('an unsynced trip is only updated locally — no network call, nothing queued', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    const localId = await engine.enqueueTrip(tripDraft())

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await engine.endTrip(localId, 1_780_003_600_000)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await db.trips.get(localId))!.ended_at).toBe(1_780_003_600_000)
    expect(await db.pendingTripEnds.count()).toBe(0)
  })

  it('an already-synced trip is updated locally and queues a pending end, drained by flush()', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    const localId = await engine.enqueueTrip(tripDraft())
    const pendingTrip = await db.trips.get(localId)
    mockFetchOnce({
      trips: [serverTrip({ id: 'srv_trip_end', client_id: pendingTrip!.client_id })],
      catches: [],
      errors: [],
    })
    await engine.flush() // trip is now synced, has a server id

    await engine.endTrip(localId, 1_780_003_600_000)
    expect((await db.trips.get(localId))!.ended_at).toBe(1_780_003_600_000)
    expect(await db.pendingTripEnds.get('srv_trip_end')).toEqual({
      trip_id: 'srv_trip_end',
      user_id: null,
      ended_at: 1_780_003_600_000,
      water_temp_c: null,
    })

    const endFetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ trip: serverTrip({ id: 'srv_trip_end', ended_at: 1_780_003_600_000 }) }),
    })
    vi.stubGlobal('fetch', endFetchSpy)

    const result = await engine.flush()
    expect(result).toEqual({ pushed: 1, failed: 0 })
    expect(endFetchSpy).toHaveBeenCalledWith(
      '/api/trips/srv_trip_end/end',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(await db.pendingTripEnds.count()).toBe(0)
  })

  it('a failed end-trip call during flush leaves it queued for retry', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    const localId = await engine.enqueueTrip(tripDraft())
    const pendingTrip = await db.trips.get(localId)
    mockFetchOnce({
      trips: [serverTrip({ id: 'srv_trip_retry', client_id: pendingTrip!.client_id })],
      catches: [],
      errors: [],
    })
    await engine.flush()
    await engine.endTrip(localId, 1_780_003_600_000)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const result = await engine.flush()
    expect(result).toEqual({ pushed: 0, failed: 1 })
    expect(await db.pendingTripEnds.count()).toBe(1)
  })
})

describe('WebSyncEngine queue ownership', () => {
  afterEach(() => setActiveUserId(null))

  it('stamps queued rows with the angler who logged them', async () => {
    setActiveUserId('usr_ayden')
    const db = freshDb()
    const engine = new WebSyncEngine(db)

    const tripLocalId = await engine.enqueueTrip(tripDraft())
    const catchLocalId = await engine.enqueueCatch(catchDraft())

    expect((await db.trips.get(tripLocalId))!.user_id).toBe('usr_ayden')
    expect((await db.catches.get(catchLocalId))!.user_id).toBe('usr_ayden')
  })

  it("never sends another angler's queued catches when someone else signs in", async () => {
    const db = freshDb()

    setActiveUserId('usr_first')
    const firstEngine = new WebSyncEngine(db)
    await firstEngine.enqueueCatch(catchDraft({ species: 'largemouth_bass' }))

    // A second angler signs in on the same phone and their app flushes.
    setActiveUserId('usr_second')
    const fetchMock = mockFetchOnce({ trips: [], catches: [], errors: [] })
    const result = await new WebSyncEngine(db).flush()

    expect(fetchMock).not.toHaveBeenCalled() // nothing of theirs to push
    expect(result).toEqual({ pushed: 0, failed: 0 })
    // The first angler's catch is untouched, still queued, still theirs.
    const queued = await db.catches.toArray()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ user_id: 'usr_first', synced_at: null })
  })

  it('sends them once their own owner is back', async () => {
    const db = freshDb()
    setActiveUserId('usr_first')
    await new WebSyncEngine(db).enqueueCatch(catchDraft())

    setActiveUserId('usr_second')
    mockFetchOnce({ trips: [], catches: [], errors: [] })
    await new WebSyncEngine(db).flush()

    setActiveUserId('usr_first')
    mockFetchOnce({
      trips: [],
      catches: [{ ...serverCatch(), client_id: (await db.catches.toArray())[0]!.client_id! }],
      errors: [],
    })
    const result = await new WebSyncEngine(db).flush()

    expect(result.pushed).toBe(1)
    expect((await db.catches.toArray())[0]!.synced_at).not.toBeNull()
  })

  it('adopts an unstamped row from before the queue tracked owners, and stamps it', async () => {
    const db = freshDb()
    // A row written by a pre-v3 client: no owner recorded, and no way to recover one.
    await db.catches.put({
      ...catchDraft(),
      local_id: 'legacy_1',
      user_id: null,
      client_id: 'legacy_client_1',
      id: null,
      synced_at: null,
    })

    setActiveUserId('usr_ayden')
    mockFetchOnce({ trips: [], catches: [{ ...serverCatch(), client_id: 'legacy_client_1' }], errors: [] })
    const result = await new WebSyncEngine(db).flush()

    expect(result.pushed).toBe(1)
    expect(await db.catches.get('legacy_1')).toMatchObject({ user_id: 'usr_ayden' })
  })
})

describe('WebSyncEngine flush under a changed session', () => {
  afterEach(() => {
    setActiveUserId(null)
    setSessionMismatchHandler(null)
  })

  it('names the account it is flushing for on every write', async () => {
    const db = freshDb()
    setActiveUserId('usr_a')
    const engine = new WebSyncEngine(db)
    await engine.enqueueCatch(catchDraft())

    const fetchSpy = mockFetchOnce({ trips: [], catches: [], errors: [] })
    await engine.flush()

    const headers = fetchSpy.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['X-Waterlog-User']).toBe('usr_a')
  })

  it('leaves everything queued and re-resolves the session when the server says it is somebody else', async () => {
    const db = freshDb()
    setActiveUserId('usr_a')
    const engine = new WebSyncEngine(db)
    const localId = await engine.enqueueCatch(catchDraft({ notes: 'the brush pile off the point' }))

    // Another tab signed out and back in as B; this tab still thinks it is A.
    const resolved = vi.fn(() => setActiveUserId('usr_b'))
    setSessionMismatchHandler(resolved)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'session_mismatch' }) }),
    )

    const result = await engine.flush()

    expect(result).toEqual({ pushed: 0, failed: 1 })
    expect(resolved).toHaveBeenCalledTimes(1)
    // A's private notes are still A's, still unsent, still unsynced.
    const row = (await db.catches.get(localId))!
    expect(row.user_id).toBe('usr_a')
    expect(row.synced_at).toBeNull()
    expect(row.id).toBeNull()
  })

  it('stops the flush at the first rejected trip end rather than pushing the rest', async () => {
    const db = freshDb()
    setActiveUserId('usr_a')
    await db.pendingTripEnds.bulkPut([
      { trip_id: 'srv_t1', user_id: 'usr_a', ended_at: 1, water_temp_c: null },
      { trip_id: 'srv_t2', user_id: 'usr_a', ended_at: 2, water_temp_c: null },
    ])
    setSessionMismatchHandler(() => setActiveUserId('usr_b'))
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'session_mismatch' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await new WebSyncEngine(db).flush()

    expect(result).toEqual({ pushed: 0, failed: 2 })
    expect(fetchSpy).toHaveBeenCalledTimes(1) // the second end was never attempted
    expect(await db.pendingTripEnds.count()).toBe(2)
  })
})
