import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActiveUserId } from '../../lib/auth/active-user'
import type { LocalCatch } from '../../lib/db'
import { WaterlogDb } from '../../lib/db'
import { recentLureIds, recentSpecies } from './recents'

const ANGLER = 'usr_a'

let dbCounter = 0
function freshDb(): WaterlogDb {
  dbCounter += 1
  return new WaterlogDb(`test-recents-${dbCounter}`)
}

function catchRow(overrides: Partial<LocalCatch> = {}): LocalCatch {
  return {
    local_id: crypto.randomUUID(),
    user_id: ANGLER,
    client_id: crypto.randomUUID(),
    id: null,
    trip_id: null,
    lure_id: null,
    species: 'largemouth_bass',
    caught_at: Date.now(),
    lat: null,
    lng: null,
    photo_key: null,
    length_mm: null,
    weight_g: null,
    depth_m: null,
    released: null,
    notes: null,
    synced_at: null,
    ...overrides,
  }
}

beforeEach(() => setActiveUserId(ANGLER))
afterEach(() => setActiveUserId(null))

describe('recentSpecies', () => {
  it('returns distinct species, newest catch first', async () => {
    const db = freshDb()
    await db.catches.bulkPut([
      catchRow({ species: 'largemouth_bass', caught_at: 1000 }),
      catchRow({ species: 'bluegill', caught_at: 3000 }),
      catchRow({ species: 'largemouth_bass', caught_at: 2000 }), // dup species, older than bluegill
    ])

    expect(await recentSpecies(db)).toEqual(['bluegill', 'largemouth_bass'])
  })

  it('caps at the requested limit', async () => {
    const db = freshDb()
    await db.catches.bulkPut(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((species, i) => catchRow({ species, caught_at: i })),
    )
    expect(await recentSpecies(db, 3)).toHaveLength(3)
  })
})

describe('recentLureIds', () => {
  it('skips catches with no lure and returns distinct ids newest first', async () => {
    const db = freshDb()
    await db.catches.bulkPut([
      catchRow({ lure_id: 'lure_a', caught_at: 1000 }),
      catchRow({ lure_id: null, caught_at: 2500 }),
      catchRow({ lure_id: 'lure_b', caught_at: 2000 }),
    ])

    expect(await recentLureIds(db)).toEqual(['lure_b', 'lure_a'])
  })
})

describe('recents ownership', () => {
  it("shows an angler only their own catches, not the last person's to use this phone", async () => {
    const db = freshDb()
    await db.catches.bulkPut([
      catchRow({ species: 'walleye', lure_id: 'lure_theirs', caught_at: 3000, user_id: 'usr_b' }),
      catchRow({ species: 'bluegill', lure_id: 'lure_mine', caught_at: 1000 }),
    ])

    expect(await recentSpecies(db)).toEqual(['bluegill'])
    expect(await recentLureIds(db)).toEqual(['lure_mine'])
  })

  it('never counts a catch whose owner was never recorded (pre-v3 row)', async () => {
    const db = freshDb()
    await db.catches.put(catchRow({ species: 'walleye', lure_id: 'lure_x', user_id: null }))

    expect(await recentSpecies(db)).toEqual([])
    expect(await recentLureIds(db)).toEqual([])
  })

  it('has nothing to show when nobody is signed in', async () => {
    const db = freshDb()
    await db.catches.put(catchRow({ species: 'walleye', lure_id: 'lure_x' }))
    setActiveUserId(null)

    expect(await recentSpecies(db)).toEqual([])
    expect(await recentLureIds(db)).toEqual([])
  })
})
