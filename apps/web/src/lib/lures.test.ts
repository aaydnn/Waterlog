import type { Lure } from '@waterlog/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => vi.unstubAllGlobals())

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
