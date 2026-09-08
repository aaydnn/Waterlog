// @vitest-environment jsdom
import type { WaterBody } from '@waterlog/schema'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WaterlogDb } from '../../lib/db'
import type { CatchDraft, SyncEngine, SyncResult, TripDraft } from '../../lib/sync/sync-engine'
import { WebSyncEngine } from '../../lib/sync/sync-engine'
import { TripBanner } from './trip-banner'

let dbCounter = 0
function freshDb(): WaterlogDb {
  dbCounter += 1
  return new WaterlogDb(`test-trip-banner-${dbCounter}`)
}

function fakeEngine(): SyncEngine {
  return {
    enqueueTrip: vi.fn<(draft: TripDraft) => Promise<string>>(),
    enqueueCatch: vi.fn<(draft: CatchDraft) => Promise<string>>(),
    endTrip: vi.fn<(localId: string, endedAt: number) => Promise<void>>(),
    flush: vi.fn<() => Promise<SyncResult>>().mockResolvedValue({ pushed: 0, failed: 0 }),
  }
}

function water(id: string, name: string): WaterBody {
  return {
    id,
    user_id: 'u1',
    name,
    kind: 'reservoir',
    centroid_lat: 36.2331,
    centroid_lng: -83.9143,
    usgs_gauge_id: null,
    nwps_gauge_id: 'NRST1',
    is_home: 0,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
  }
}

/** No connection by default: the banner must work off the Dexie cache alone. */
function mockOffline() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline')
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('TripBanner', () => {
  it('shows Start trip when nothing is active, and starts one on tap', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db) // real engine — simplest way to assert a trip landed
    const user = userEvent.setup()
    render(<TripBanner engine={engine} db={db} />)

    const startButton = await screen.findByRole('button', { name: 'Start trip' })
    await user.click(startButton)

    expect(await screen.findByRole('status')).toHaveTextContent('Fishing since')
    expect(await db.trips.count()).toBe(1)
  })

  it('does not start a second trip on a double tap', async () => {
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    const user = userEvent.setup()
    render(<TripBanner engine={engine} db={db} />)

    await user.click(await screen.findByRole('button', { name: 'Start trip' }))
    // The banner now shows "End trip", not "Start trip" — a stray second tap has nothing to hit.
    // onStart() is fire-and-forget from the click handler, so wait for the async state update
    // (setActive after the Dexie write) to actually land before asserting on it.
    await screen.findByRole('button', { name: 'End trip' })
    expect(screen.queryByRole('button', { name: 'Start trip' })).not.toBeInTheDocument()
    expect(await db.trips.count()).toBe(1)
  })

  it('shows End trip once active, and ends it on tap', async () => {
    const db = freshDb()
    const engine = fakeEngine()
    await db.trips.put({
      local_id: 'active1',
      client_id: 'c1',
      id: null,
      water_body_id: null,
      water_temp_c: null,
      started_at: Date.now(),
      ended_at: null,
      auto_created: 0,
      planned: 0,
      notes: null,
      synced_at: null,
    })
    const user = userEvent.setup()
    render(<TripBanner engine={engine} db={db} />)

    const endButton = await screen.findByRole('button', { name: 'End trip' })
    await user.click(endButton)

    expect(engine.endTrip).toHaveBeenCalledWith('active1', expect.any(Number), null)
    expect(await screen.findByRole('button', { name: 'Start trip' })).toBeInTheDocument()
  })

  it('attaches the chosen water to the trip it starts', async () => {
    mockOffline()
    const db = freshDb()
    await db.waterBodies.bulkPut([water('wb_norris', 'Norris Lake'), water('wb_oliphant', 'Lake Oliphant')])
    const engine = new WebSyncEngine(db)
    const user = userEvent.setup()
    render(<TripBanner engine={engine} db={db} />)

    await screen.findByRole('option', { name: 'Norris Lake' })
    await user.selectOptions(screen.getByLabelText('Water'), 'wb_norris')
    await user.click(screen.getByRole('button', { name: 'Start trip' }))

    await waitFor(async () => expect((await db.trips.toArray())[0]?.water_body_id).toBe('wb_norris'))
    // The running banner names the water, so a mis-pick is visible before the fish are.
    expect(await screen.findByRole('status')).toHaveTextContent('Fishing Norris Lake since')
  })

  it('starts a trip with no water when the angler picks none', async () => {
    mockOffline()
    const db = freshDb()
    await db.waterBodies.put(water('wb_norris', 'Norris Lake'))
    const engine = new WebSyncEngine(db)
    const user = userEvent.setup()
    render(<TripBanner engine={engine} db={db} />)

    await screen.findByRole('option', { name: 'Norris Lake' })
    await user.click(screen.getByRole('button', { name: 'Start trip' }))

    await waitFor(async () => expect(await db.trips.count()).toBe(1))
    expect((await db.trips.toArray())[0]!.water_body_id).toBeNull()
  })

  it('adds a new water from the picker and selects it', async () => {
    const created = { ...water('wb_new', 'Cherokee Lake'), nwps_gauge_id: null }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/water-bodies')) {
          return init?.method === 'POST'
            ? { ok: true, status: 201, json: async () => ({ water_body: created }) }
            : { ok: true, status: 200, json: async () => ({ water_bodies: [] }) }
        }
        if (url.includes('/api/sync')) {
          return { ok: true, status: 200, json: async () => ({ trips: [], catches: [], errors: [] }) }
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    const user = userEvent.setup()
    render(<TripBanner engine={engine} db={db} />)

    await user.selectOptions(await screen.findByLabelText('Water'), '__new__')
    await user.type(screen.getByLabelText('New water name'), 'Cherokee Lake')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByRole('option', { name: 'Cherokee Lake' })
    await user.click(screen.getByRole('button', { name: 'Start trip' }))
    await waitFor(async () => expect((await db.trips.toArray())[0]?.water_body_id).toBe('wb_new'))
  })

  it('says so, rather than silently dropping it, when a new water cannot be created offline', async () => {
    mockOffline()
    const db = freshDb()
    const engine = new WebSyncEngine(db)
    const user = userEvent.setup()
    render(<TripBanner engine={engine} db={db} />)

    await user.selectOptions(await screen.findByLabelText('Water'), '__new__')
    await user.type(screen.getByLabelText('New water name'), 'Somewhere New')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByText(/Could not add that water/)).toBeInTheDocument()
  })
})
