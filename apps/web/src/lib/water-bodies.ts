import type { WaterBody } from '@waterlog/schema'
import { apiClient, type WaterBodyCreateRequest } from './api-client'
import type { WaterlogDb } from './db'
import { distanceKm, type Position } from './geo'

/** Preselect the nearest water only when the angler is plausibly *at* it. The radius has to
 * clear a big reservoir's own extent, not a boat ramp's: Norris Dam sits 39 km from the lake's
 * centroid, so the packet's 300 m test — or any tight one — would never fire on exactly the
 * waters this product targets (ADR-0009). The choice stays visible and one tap away either
 * way, and the running banner names the water it started on. */
export const NEAR_WATER_KM = 60

/** Refreshes the local cache from the server; falls back to whatever's cached when offline
 * (packet principle 5). Always returns what's available locally after attempting the refresh. */
export async function syncWaterBodies(db: WaterlogDb): Promise<WaterBody[]> {
  try {
    const { water_bodies } = await apiClient.listWaterBodies()
    await db.waterBodies.bulkPut(water_bodies)
  } catch {
    // offline or the API is down — serve whatever's cached
  }
  return db.waterBodies.toArray()
}

/** Requires connectivity, like lure quick-add: a picker needs the server-assigned id. */
export async function createWaterBody(db: WaterlogDb, input: WaterBodyCreateRequest): Promise<WaterBody> {
  const { water_body } = await apiClient.createWaterBody(input)
  await db.waterBodies.put(water_body)
  return water_body
}

export interface RankedWater {
  water: WaterBody
  /** null when either the angler or the water has no coordinates. */
  km: number | null
}

/** Nearest first when there's a fix, otherwise the server's order (home water, then A-Z).
 * Waters with no centroid sort last — they can't be ranked, but must stay reachable. */
export function rankByDistance(waters: WaterBody[], position: Position | null): RankedWater[] {
  const ranked = waters.map((water) => ({
    water,
    km:
      position && water.centroid_lat !== null && water.centroid_lng !== null
        ? distanceKm(position, { lat: water.centroid_lat, lng: water.centroid_lng })
        : null,
  }))
  if (!position) return ranked
  return ranked.sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity))
}

/** The water to preselect: the nearest one the angler is plausibly at, else their home water,
 * else nothing — never a silent guess at a water tens of km away. */
export function defaultWaterId(ranked: RankedWater[]): string | null {
  const nearest = ranked[0]
  if (nearest && nearest.km !== null && nearest.km <= NEAR_WATER_KM) return nearest.water.id
  return ranked.find((r) => r.water.is_home === 1)?.water.id ?? null
}
