// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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

    expect(engine.endTrip).toHaveBeenCalledWith('active1', expect.any(Number))
    expect(await screen.findByRole('button', { name: 'Start trip' })).toBeInTheDocument()
  })
})
