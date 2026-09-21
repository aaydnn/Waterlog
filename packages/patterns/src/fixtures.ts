import type { CatchEvent, ExposureHour, PatternInput } from './types'

/**
 * Test fixtures, kept out of the test files so every suite describes the same kind of angler.
 * Not exported from the package: this is scaffolding for the specs, not part of the engine.
 */

export const HOUR = 3_600_000
/** An arbitrary epoch hour to hang fixtures off, far from zero so nothing accidentally lines up
 * with a default. */
const BASE_BUCKET = 490_000

export interface TripSpec {
  water?: string | null
  /** How many exposure hours this trip produced. */
  hours: number
  /** Conditions that held for every hour of it. */
  conditions?: Partial<ExposureHour>
  /** Per-hour overrides, by hour index, for a trip whose weather moved. */
  hourOverrides?: Record<number, Partial<ExposureHour>>
  /** Catches, each placed in the hour at `hour` (defaults to spreading across the trip). */
  catches?: { hour?: number; family?: string | null; color?: string | null }[]
  /** Hour indexes whose `conditions` row never arrived, leaving a hole in the trip. */
  missingHours?: number[]
  /** Catches that land past the trip's last measured hour, to exercise the clamp. */
  lateCatches?: { minutesPastEnd: number; family?: string | null; color?: string | null }[]
}

export function build(specs: TripSpec[]): PatternInput {
  const hours: ExposureHour[] = []
  const catches: CatchEvent[] = []
  let bucket = BASE_BUCKET

  specs.forEach((spec, tripIndex) => {
    const tripId = `trip${tripIndex}`
    const firstBucket = bucket
    for (let i = 0; i < spec.hours; i += 1) {
      if (spec.missingHours?.includes(i)) continue
      hours.push({
        trip_id: tripId,
        water_body_id: spec.water ?? null,
        hour_bucket: firstBucket + i,
        pressure_trend: null,
        cloud_pct: null,
        wind_kph: null,
        water_temp_c: null,
        moon_phase: null,
        minutes_from_sunrise: null,
        season: null,
        ...spec.conditions,
        ...spec.hourOverrides?.[i],
      })
    }
    spec.catches?.forEach((c, i) => {
      const hourIndex = c.hour ?? i % Math.max(1, spec.hours)
      catches.push({
        id: `${tripId}_c${i}`,
        trip_id: tripId,
        caught_at: (firstBucket + hourIndex) * HOUR + 60_000,
        lure_family: c.family ?? null,
        lure_color: c.color ?? null,
      })
    })
    spec.lateCatches?.forEach((c, i) => {
      catches.push({
        id: `${tripId}_late${i}`,
        trip_id: tripId,
        caught_at: (firstBucket + spec.hours) * HOUR + c.minutesPastEnd * 60_000,
        lure_family: c.family ?? null,
        lure_color: c.color ?? null,
      })
    })
    // Leave a gap so no two trips share an epoch hour.
    bucket = firstBucket + spec.hours + 24
  })

  return { hours, catches }
}

/** `n` trips built from the same spec — the usual way to get past a distinct-trip minimum. */
export function repeat(count: number, spec: TripSpec): TripSpec[] {
  return Array.from({ length: count }, () => spec)
}
