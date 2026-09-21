import { env } from 'cloudflare:test'
import { ulid } from 'ulid'

/**
 * Writes an angler's history straight into D1, in the shape the enrich worker would have left it:
 * trips, their catches, and one `conditions` row per trip-hour. The recompute reads real rows
 * through real SQL, so the fixtures have to be real rows.
 */

const HOUR_MS = 3_600_000
const BASE_BUCKET = 490_000

let nextBucket = BASE_BUCKET

/**
 * Water ids are per-angler, because two anglers in the same suite fishing "lake1" are two
 * different waters and share no row. The `w` prefix keeps every water id sorting after the `all`
 * scope, which is the order the recompute walks them in.
 */
const waterIds = new Map<string, string>()
let nextWater = 0

function registerWater(userId: string, name: string): string {
  const key = `${userId}|${name}`
  const existing = waterIds.get(key)
  if (existing) return existing
  nextWater += 1
  const id = `w${String(nextWater).padStart(4, '0')}_${name}`
  waterIds.set(key, id)
  return id
}

/** The id a seeded water ended up with, for asserting on scopes. */
export function waterIdFor(userId: string, name: string): string {
  return waterIds.get(`${userId}|${name}`)!
}

export interface TripSeed {
  water?: string | null
  hours: number
  /** Conditions that held for every hour of the trip. */
  conditions: Partial<{
    pressure_trend: 'falling' | 'stable' | 'rising'
    cloud_pct: number
    wind_kph: number
    water_temp_c: number
    moon_phase: number
    minutes_from_sunrise: number
    season: string
  }>
  hourOverrides?: Record<number, Partial<TripSeed['conditions']>>
  catches?: { hour: number; family?: string; color?: string }[]
  /** An open trip: no `ended_at`, and therefore no hour buckets at all. */
  open?: boolean
}

export interface AnglerSeed {
  email: string
  trips: TripSeed[]
}

export async function seedAngler(seed: AnglerSeed): Promise<string> {
  const userId = ulid()
  const now = Date.now()
  await env.DB.prepare(
    "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES (?, ?, 'imperial', 'pro', ?, ?)",
  )
    .bind(userId, seed.email, now, now)
    .run()

  const waters = new Set<string>()
  for (const trip of seed.trips) {
    if (trip.water) waters.add(trip.water)
  }
  for (const water of waters) {
    const id = registerWater(userId, water)
    await env.DB.prepare(
      "INSERT INTO water_bodies (id, user_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, 'lake', ?, ?)",
    )
      .bind(id, userId, `Water ${water}`, now, now)
      .run()
  }

  const lures = new Map<string, string>()
  async function lureFor(family: string | undefined, color: string | undefined): Promise<string> {
    const key = `${family ?? ''}|${color ?? ''}`
    const existing = lures.get(key)
    if (existing) return existing
    const id = ulid()
    await env.DB.prepare(
      'INSERT INTO lures (id, user_id, name, family, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, userId, key, family ?? null, color ?? null, now, now)
      .run()
    lures.set(key, id)
    return id
  }

  for (const trip of seed.trips) {
    const tripId = ulid()
    const firstBucket = nextBucket
    nextBucket += trip.hours + 24
    const startedAt = firstBucket * HOUR_MS
    const endedAt = trip.open ? null : startedAt + trip.hours * HOUR_MS

    await env.DB.prepare(
      `INSERT INTO trips (id, user_id, water_body_id, started_at, ended_at, auto_created, planned, created_at, updated_at, client_id)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    )
      .bind(
        tripId,
        userId,
        trip.water ? registerWater(userId, trip.water) : null,
        startedAt,
        endedAt,
        now,
        now,
        ulid(),
      )
      .run()

    if (!trip.open) {
      for (let i = 0; i < trip.hours; i += 1) {
        const conditions = { ...trip.conditions, ...trip.hourOverrides?.[i] }
        await env.DB.prepare(
          `INSERT INTO conditions (id, user_id, trip_id, hour_bucket, cloud_pct, wind_kph, pressure_trend,
                                   moon_phase, minutes_from_sunrise, water_temp_c, season, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            ulid(),
            userId,
            tripId,
            firstBucket + i,
            conditions.cloud_pct ?? null,
            conditions.wind_kph ?? null,
            conditions.pressure_trend ?? null,
            conditions.moon_phase ?? null,
            conditions.minutes_from_sunrise ?? null,
            conditions.water_temp_c ?? null,
            conditions.season ?? null,
            now,
          )
          .run()
      }
    }

    for (const [index, entry] of (trip.catches ?? []).entries()) {
      const lureId =
        entry.family || entry.color ? await lureFor(entry.family, entry.color) : null
      await env.DB.prepare(
        `INSERT INTO catches (id, user_id, trip_id, lure_id, species, caught_at, released, enrich_status, created_at, updated_at, client_id)
         VALUES (?, ?, ?, ?, 'largemouth_bass', ?, 1, 'done', ?, ?, ?)`,
      )
        .bind(
          ulid(),
          userId,
          tripId,
          lureId,
          (firstBucket + entry.hour) * HOUR_MS + 60_000 + index,
          now,
          now,
          ulid(),
        )
        .run()
    }
  }

  return userId
}
