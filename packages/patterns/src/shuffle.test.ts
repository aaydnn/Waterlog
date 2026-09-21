import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { computePatterns } from './compute'
import type { CatchEvent, ExposureHour } from './types'

/**
 * Packet §08 requires a property test asserting that shuffling the input rows never changes the
 * output. It is the claim the whole engine rests on: a nightly recompute must produce the same
 * feed whatever order D1 hands the rows back in, and an angler must never see a pattern appear
 * or move because a query planner changed its mind.
 *
 * The engine is built to make this true rather than to pass this test — keys are sorted before
 * they are used, exposure is tallied as integer counts per denominator instead of accumulated
 * floats, and every output is sorted canonically. The property is what proves it stayed true.
 */

const TRIP_COUNT = 6
const BASE_BUCKET = 480_000
const HOUR_MS = 3_600_000

const conditionArb = fc.record({
  pressure_trend: fc.constantFrom('falling', 'stable', 'rising', null),
  cloud_pct: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
  wind_kph: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
  water_temp_c: fc.option(fc.integer({ min: -2, max: 30 }), { nil: null }),
  moon_phase: fc.option(fc.integer({ min: 0, max: 100 }).map((n) => n / 100), { nil: null }),
  minutes_from_sunrise: fc.option(fc.integer({ min: -200, max: 900 }), { nil: null }),
  season: fc.constantFrom('spring', 'summer', 'fall', 'winter', null),
})

const lureArb = fc.record({
  lure_family: fc.constantFrom('spinnerbait', 'jig', 'crankbait', null),
  lure_color: fc.constantFrom('chartreuse', 'white', 'black', null),
})

/** An angler's whole history: a handful of trips, each a run of hours with fish scattered in. */
const anglerArb = fc
  .array(
    fc.record({
      water: fc.constantFrom('lake1', 'lake2', null),
      hourCount: fc.integer({ min: 1, max: 8 }),
      conditions: fc.array(conditionArb, { minLength: 1, maxLength: 8 }),
      catches: fc.array(fc.record({ hourOffset: fc.integer({ min: 0, max: 10 }), lure: lureArb }), {
        maxLength: 6,
      }),
    }),
    { minLength: TRIP_COUNT, maxLength: TRIP_COUNT },
  )
  .map((trips) => {
    const hours: ExposureHour[] = []
    const catches: CatchEvent[] = []
    trips.forEach((trip, tripIndex) => {
      const tripId = `t${tripIndex}`
      const firstBucket = BASE_BUCKET + tripIndex * 100
      for (let i = 0; i < trip.hourCount; i += 1) {
        hours.push({
          trip_id: tripId,
          water_body_id: trip.water,
          hour_bucket: firstBucket + i,
          ...trip.conditions[i % trip.conditions.length]!,
        })
      }
      trip.catches.forEach((c, i) => {
        catches.push({
          id: `${tripId}c${i}`,
          trip_id: tripId,
          caught_at: (firstBucket + c.hourOffset) * HOUR_MS + 90_000,
          ...c.lure,
        })
      })
    })
    return { hours, catches }
  })

function shuffled<T>(rows: T[], seed: number): T[] {
  const copy = [...rows]
  let state = seed || 1
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff
    const j = state % (i + 1)
    const swap = copy[i]!
    copy[i] = copy[j]!
    copy[j] = swap
  }
  return copy
}

describe('shuffle invariance', () => {
  it('produces byte-identical output however the rows are ordered', () => {
    fc.assert(
      fc.property(anglerArb, fc.integer({ min: 1, max: 1_000_000 }), (input, seed) => {
        const ordered = computePatterns(input)
        const jumbled = computePatterns({
          hours: shuffled(input.hours, seed),
          catches: shuffled(input.catches, seed * 7 + 1),
        })
        expect(JSON.stringify(jumbled)).toBe(JSON.stringify(ordered))
      }),
      { numRuns: 300 },
    )
  })

  it('never emits a multiplier that is not a finite number', () => {
    fc.assert(
      fc.property(anglerArb, (input) => {
        for (const pattern of computePatterns(input).patterns) {
          expect(Number.isFinite(pattern.multiplier)).toBe(true)
          expect(Number.isFinite(pattern.rate)).toBe(true)
          expect(pattern.hours).toBeGreaterThan(0)
        }
      }),
      { numRuns: 200 },
    )
  })
})
