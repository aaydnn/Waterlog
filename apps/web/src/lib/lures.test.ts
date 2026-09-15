import type { Lure } from '@waterlog/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveUserId } from './auth/active-user'
import { WaterlogDb } from './db'
import { createLure, syncLures } from './lures'

let dbCounter = 0
function freshDb(): WaterlogDb {
  dbCounter += 1
  return new WaterlogDb(`test-lures-${dbCounter}`)
}

function fakeLure(overrides: Partial<Lure> = {}): Lure {
  return {
    id: 'lure_1',
    user_id: 'usr_1',
    name: 'Ned Rig',
    family: null,
    color: null,
    cost_cents: null,
    retired_at: null,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
    ...overrides,
  }
}

function mockFetch(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body }))
}

beforeEach(() => setActiveUserId('usr_1'))
afterEach(() => {
  setActiveUserId(null)
  vi.unstubAllGlobals()
})

describe('syncLures', () => {
  it('caches the fetched lures and returns them', async () => {
    const db = freshDb()
    mockFetch({ lures: [fakeLure({ id: 'l1' })] })

    const result = await syncLures(db)
    expect(result.map((l) => l.id)).toEqual(['l1'])
    expect(await db.lures.get('l1')).toBeDefined()
  })

  it('falls back to the cache when the fetch fails (offline)', async () => {
    const db = freshDb()
    await db.lures.put(fakeLure({ id: 'cached', name: 'Cached Jig' }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const result = await syncLures(db)
    expect(result.map((l) => l.id)).toEqual(['cached'])
  })

  it("never shows one angler the other's cached tackle box", async () => {
    const db = freshDb()
    // The first angler's lures are already cached on this phone.
    mockFetch({ lures: [fakeLure({ id: 'a1', user_id: 'usr_a', name: 'A Ned Rig' })] })
    setActiveUserId('usr_a')
    expect((await syncLures(db)).map((l) => l.id)).toEqual(['a1'])

    // A second angler signs in and has no lures of their own yet.
    setActiveUserId('usr_b')
    mockFetch({ lures: [] })
    expect(await syncLures(db)).toEqual([])

    // Signing back in gets the first angler's own list back, untouched by the visitor.
    setActiveUserId('usr_a')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect((await syncLures(db)).map((l) => l.id)).toEqual(['a1'])
  })

  it('drops a lure the server no longer lists, without touching anyone else’s', async () => {
    const db = freshDb()
    await db.lures.bulkPut([
      fakeLure({ id: 'mine_kept', user_id: 'usr_1' }),
      fakeLure({ id: 'mine_deleted', user_id: 'usr_1' }),
      fakeLure({ id: 'theirs', user_id: 'usr_other' }),
    ])
    mockFetch({ lures: [fakeLure({ id: 'mine_kept', user_id: 'usr_1' })] })

    expect((await syncLures(db)).map((l) => l.id)).toEqual(['mine_kept'])
    expect(await db.lures.get('mine_deleted')).toBeUndefined()
    expect(await db.lures.get('theirs')).toBeDefined()
  })

  it('returns nothing to a legacy cache row with no owner, or with nobody signed in', async () => {
    const db = freshDb()
    // Written by a pre-v4 client: no owner recorded, so it belongs to nobody.
    await db.lures.put({ ...fakeLure({ id: 'legacy' }), user_id: undefined } as unknown as Lure)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    expect(await syncLures(db)).toEqual([])

    setActiveUserId(null)
    expect(await syncLures(db)).toEqual([])
  })
})

describe('createLure', () => {
  it('creates remotely and caches the result', async () => {
    const db = freshDb()
    mockFetch({ lure: fakeLure({ id: 'new1', name: 'Zoom Fluke' }) })

    const lure = await createLure(db, 'Zoom Fluke')
    expect(lure.id).toBe('new1')
    expect(await db.lures.get('new1')).toBeDefined()
  })
})
