import type { WaterBody } from '@waterlog/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveUserId } from './auth/active-user'
import { WaterlogDb } from './db'
import { defaultWaterId, rankByDistance, syncWaterBodies } from './water-bodies'

function water(name: string, lat: number | null, lng: number | null, isHome: 0 | 1 = 0): WaterBody {
  return {
    id: `wb_${name.toLowerCase().replace(/\W+/g, '_')}`,
    user_id: 'u1',
    name,
    kind: null,
    centroid_lat: lat,
    centroid_lng: lng,
    usgs_gauge_id: null,
    nwps_gauge_id: null,
    is_home: isHome,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
  }
}

// Real coordinates, so the distances are the ones the founder will actually see.
const NORRIS = water('Norris Lake', 36.3572, -83.6848) // OSM centroid, per the Epic 2 field sweep
const OLIPHANT = water('Lake Oliphant', 34.796, -81.183)
const NORRIS_DAM = { lat: 36.2266, lng: -84.0928 } // 39 km from the lake's own centroid

describe('rankByDistance', () => {
  it('keeps the server order when there is no fix', () => {
    const ranked = rankByDistance([NORRIS, OLIPHANT], null)
    expect(ranked.map((r) => r.water.name)).toEqual(['Norris Lake', 'Lake Oliphant'])
    expect(ranked.every((r) => r.km === null)).toBe(true)
  })

  it('puts the nearest water first', () => {
    const ranked = rankByDistance([OLIPHANT, NORRIS], NORRIS_DAM)
    expect(ranked[0]!.water.name).toBe('Norris Lake')
    // The dam is far from the centroid — the reason NEAR_WATER_KM is not a boat-ramp radius.
    expect(ranked[0]!.km).toBeGreaterThan(35)
    expect(ranked[0]!.km).toBeLessThan(45)
    expect(ranked[1]!.km).toBeGreaterThan(250) // Lake Oliphant is in another state
  })

  it('sorts an uncoordinated water last without dropping it', () => {
    const ranked = rankByDistance([water('Farm pond', null, null), NORRIS], NORRIS_DAM)
    expect(ranked.map((r) => r.water.name)).toEqual(['Norris Lake', 'Farm pond'])
    expect(ranked[1]!.km).toBeNull()
  })
})

describe('defaultWaterId', () => {
  it('preselects the nearest water when the angler is plausibly at it', () => {
    expect(defaultWaterId(rankByDistance([OLIPHANT, NORRIS], NORRIS_DAM))).toBe(NORRIS.id)
  })

  it('falls back to the home water rather than guessing at a water hours away', () => {
    const home = water('Home pond', 40, -80, 1)
    const ranked = rankByDistance([NORRIS, home], { lat: 25.7617, lng: -80.1918 }) // Miami
    expect(defaultWaterId(ranked)).toBe(home.id)
  })

  it('preselects nothing when there is no fix and no home water', () => {
    expect(defaultWaterId(rankByDistance([NORRIS, OLIPHANT], null))).toBeNull()
  })

  it('preselects nothing at all when the angler has no waters yet', () => {
    expect(defaultWaterId([])).toBeNull()
  })
})

describe('syncWaterBodies', () => {
  let dbCounter = 0
  const freshDb = () => new WaterlogDb(`test-waters-${(dbCounter += 1)}`)
  const owned = (w: WaterBody, userId: string): WaterBody => ({ ...w, user_id: userId })
  const serve = (waters: WaterBody[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ water_bodies: waters }) }),
    )
  const offline = () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

  beforeEach(() => setActiveUserId('usr_a'))
  afterEach(() => {
    setActiveUserId(null)
    vi.unstubAllGlobals()
  })

  it("never hands a second angler the first one's waters — coordinates and all", async () => {
    const db = freshDb()
    serve([owned(NORRIS, 'usr_a')])
    expect((await syncWaterBodies(db)).map((w) => w.name)).toEqual(['Norris Lake'])

    // Somebody else signs in on this phone. Their list is empty; so is what they see.
    setActiveUserId('usr_b')
    serve([])
    expect(await syncWaterBodies(db)).toEqual([])

    // And the first angler's spots survived the visit.
    setActiveUserId('usr_a')
    offline()
    expect((await syncWaterBodies(db)).map((w) => w.name)).toEqual(['Norris Lake'])
  })

  it('forgets a water the server no longer lists, but only the signed-in angler’s', async () => {
    const db = freshDb()
    await db.waterBodies.bulkPut([owned(NORRIS, 'usr_a'), owned(OLIPHANT, 'usr_b')])
    serve([owned(NORRIS, 'usr_a')])

    expect((await syncWaterBodies(db)).map((w) => w.id)).toEqual([NORRIS.id])
    expect(await db.waterBodies.get(OLIPHANT.id)).toBeDefined()

    serve([])
    expect(await syncWaterBodies(db)).toEqual([])
    expect(await db.waterBodies.get(NORRIS.id)).toBeUndefined()
    expect(await db.waterBodies.get(OLIPHANT.id)).toBeDefined()
  })

  it('shows nothing from a pre-v4 cache row with no owner, and nothing at all when signed out', async () => {
    const db = freshDb()
    await db.waterBodies.put({ ...NORRIS, user_id: undefined } as unknown as WaterBody)
    offline()

    expect(await syncWaterBodies(db)).toEqual([])

    setActiveUserId(null)
    expect(await syncWaterBodies(db)).toEqual([])
  })
})
