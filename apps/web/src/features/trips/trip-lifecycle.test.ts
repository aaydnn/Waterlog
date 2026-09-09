import { describe, expect, it, vi } from 'vitest'
import { WaterlogDb } from '../../lib/db'
import type { CatchDraft, SyncEngine, SyncResult, TripDraft } from '../../lib/sync/sync-engine'
import { WebSyncEngine } from '../../lib/sync/sync-engine'
import { endActiveTrip, getActiveTrip, startTrip, tripReferenceFor } from './trip-lifecycle'

let dbCounter = 0
function freshDb(): WaterlogDb {
  dbCounter += 1
  return new WaterlogDb(`test-triplife-${dbCounter}`)
}

function fakeEngine(): SyncEngine {
  return {
    enqueueTrip: vi.fn<(draft: TripDraft) => Promise<string>>(),
    enqueueCatch: vi.fn<(draft: CatchDraft) => Promise<string>>(),
    endTrip: vi.fn<(localId: string, endedAt: number) => Promise<void>>(),
    flush: vi.fn<() => Promise<SyncResult>>(),
  }
}

describe('getActiveTrip', () => {
  it('returns null when there is no open trip', async () => {
    expect(await getActiveTrip(freshDb())).toBeNull()
  })

  it('returns the most recently started open trip', async () => {
    const db = freshDb()
    await db.trips.bulkPut([
      {
        local_id: 'older',
        user_id: null,
        client_id: 'c1',
        id: null,
        water_body_id: null,
        started_at: 1000,
        ended_at: null,
        auto_created: 0,
        planned: 0,
        notes: null,
        water_temp_c: null,
        synced_at: null,
      },
      {
        local_id: 'newer',
        user_id: null,
        client_id: 'c2',
        id: null,
        water_body_id: null,
        started_at: 2000,
        ended_at: null,
        auto_created: 0,
        planned: 0,
        notes: null,
        water_temp_c: null,
        synced_at: null,
      },
      {
        local_id: 'ended',
        user_id: null,
        client_id: 'c3',
        id: null,
        water_body_id: null,
        started_at: 3000,
        ended_at: 3500,
        auto_created: 0,
        planned: 0,
        notes: null,
        water_temp_c: null,
        synced_at: null,
      },
    ])

    expect((await getActiveTrip(db))!.local_id).toBe('newer')
  })
})

describe('startTrip', () => {
  it('enqueues a new trip via the engine and returns the local row', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db) // real, Dexie-backed — simplest way to get a real local row back

    const trip = await startTrip(engine, db)
    expect(trip.ended_at).toBeNull()
    expect(await getActiveTrip(db)).not.toBeNull()
  })

  it('is a no-op if a trip is already active (no double-start)', async () => {
    const db = freshDb()
    const engine = fakeEngine()
    await db.trips.put({
      local_id: 'already-active',
      user_id: null,
      client_id: 'c1',
      id: null,
      water_body_id: null,
      started_at: 1000,
      ended_at: null,
      auto_created: 0,
      planned: 0,
      notes: null,
      water_temp_c: null,
      synced_at: null,
    })

    const trip = await startTrip(engine, db)
    expect(trip.local_id).toBe('already-active')
    expect(engine.enqueueTrip).not.toHaveBeenCalled()
  })
})

describe('endActiveTrip', () => {
  it('ends the active trip via the engine', async () => {
    const db = freshDb()
    const engine = fakeEngine()
    await db.trips.put({
      local_id: 'active',
      user_id: null,
      client_id: 'c1',
      id: null,
      water_body_id: null,
      started_at: 1000,
      ended_at: null,
      auto_created: 0,
      planned: 0,
      notes: null,
      water_temp_c: null,
      synced_at: null,
    })

    await endActiveTrip(engine, db)
    expect(engine.endTrip).toHaveBeenCalledWith('active', expect.any(Number), null)
  })

  it('is a no-op when there is no active trip', async () => {
    const engine = fakeEngine()
    await endActiveTrip(engine, freshDb())
    expect(engine.endTrip).not.toHaveBeenCalled()
  })
})

describe('tripReferenceFor', () => {
  const base = {
    local_id: 'loc1',
    user_id: null,
    client_id: 'cli1',
    water_body_id: null,
    started_at: 0,
    ended_at: null,
    auto_created: 0 as const,
    planned: 0 as const,
    notes: null,
    water_temp_c: null,
    synced_at: null,
  }

  it('prefers the server id once synced', () => {
    expect(tripReferenceFor({ ...base, id: 'srv1' })).toBe('srv1')
  })

  it('falls back to local_id when not yet synced', () => {
    expect(tripReferenceFor({ ...base, id: null })).toBe('loc1')
  })

  it('returns null for no active trip', () => {
    expect(tripReferenceFor(null)).toBeNull()
  })
})

