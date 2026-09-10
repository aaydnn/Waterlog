// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WaterlogDb } from '../db'
import type { CatchDraft } from '../sync/sync-engine'
import { WebSyncEngine } from '../sync/sync-engine'
import { setActiveUserId } from './active-user'
import { canAdoptUnowned, forgetDeviceAccounts, rememberAccount } from './device-accounts'

let dbCounter = 0
function freshDb(): WaterlogDb {
  dbCounter += 1
  return new WaterlogDb(`test-device-accounts-${dbCounter}`)
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

afterEach(() => {
  forgetDeviceAccounts()
  setActiveUserId(null)
  vi.unstubAllGlobals()
})

describe('canAdoptUnowned', () => {
  it('is true on a device no account, or one account, has used', () => {
    expect(canAdoptUnowned('usr_a')).toBe(true)
    rememberAccount('usr_a')
    expect(canAdoptUnowned('usr_a')).toBe(true)
  })

  it('is false once a second account has signed in here', () => {
    rememberAccount('usr_a')
    rememberAccount('usr_b')
    expect(canAdoptUnowned('usr_a')).toBe(false)
    expect(canAdoptUnowned('usr_b')).toBe(false)
  })

  it('records every account that becomes active, without duplicating one', () => {
    setActiveUserId('usr_a')
    setActiveUserId('usr_a')
    expect(canAdoptUnowned('usr_a')).toBe(true)

    setActiveUserId('usr_b')
    expect(canAdoptUnowned('usr_b')).toBe(false)
  })
})

describe('flushing a row whose owner was never recorded', () => {
  it('never sends it once a second angler has used this device', async () => {
    const db = freshDb()
    // A pre-v3 row: queued before the queue recorded owners, so it names nobody.
    await db.catches.put({
      ...catchDraft({ notes: 'the brush pile off the point' }),
      local_id: 'legacy_1',
      user_id: null,
      client_id: 'legacy_client_1',
      id: null,
      synced_at: null,
    })
    setActiveUserId('usr_a')
    setActiveUserId('usr_b') // a second angler has signed in on this phone

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await new WebSyncEngine(db).flush()).toEqual({ pushed: 0, failed: 0 })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await db.catches.get('legacy_1'))!.synced_at).toBeNull()
  })
})
