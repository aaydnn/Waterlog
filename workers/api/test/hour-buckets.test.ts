import { describe, expect, it } from 'vitest'
import { MAX_TRIP_HOUR_BUCKETS, computeHourBuckets } from '../src/lib/hour-buckets'

const HOUR_MS = 60 * 60 * 1000

describe('computeHourBuckets', () => {
  it('a 4.5h trip yields exactly 5 hour-bucket rows (packet §10 acceptance criterion)', () => {
    const start = Date.UTC(2026, 5, 1, 10, 15) // 10:15, not hour-aligned
    const end = start + 4.5 * HOUR_MS
    expect(computeHourBuckets(start, end)).toHaveLength(5)
  })

  it('buckets are sequential epoch hours anchored to trip start, not wall-clock alignment', () => {
    const start = Date.UTC(2026, 5, 1, 10, 15)
    const end = start + 4.5 * HOUR_MS
    const firstBucket = Math.floor(start / HOUR_MS)
    expect(computeHourBuckets(start, end)).toEqual([
      firstBucket,
      firstBucket + 1,
      firstBucket + 2,
      firstBucket + 3,
      firstBucket + 4,
    ])
  })

  it('an exact 1h trip yields exactly 1 bucket', () => {
    const start = Date.UTC(2026, 5, 1, 10, 0)
    expect(computeHourBuckets(start, start + HOUR_MS)).toHaveLength(1)
  })

  it('a zero-length trip still yields 1 bucket (never blocking)', () => {
    const start = Date.UTC(2026, 5, 1, 10, 0)
    expect(computeHourBuckets(start, start)).toHaveLength(1)
  })

  it('a sub-hour trip yields 1 bucket', () => {
    const start = Date.UTC(2026, 5, 1, 10, 0)
    expect(computeHourBuckets(start, start + 20 * 60 * 1000)).toHaveLength(1)
  })
})

// Finding 4: an unbounded bucket list is unbounded enrichment work — one bucket is one
// conditions row and one round of weather/gauge lookups in the enrich worker.
describe('computeHourBuckets is bounded', () => {
  it('clamps a year-long trip to the 48-bucket ceiling instead of 8,760 buckets', () => {
    const start = Date.UTC(2025, 5, 1, 10, 0)
    const end = start + 365 * 24 * HOUR_MS
    const buckets = computeHourBuckets(start, end)
    expect(buckets).toHaveLength(MAX_TRIP_HOUR_BUCKETS)
    expect(buckets[0]).toBe(Math.floor(start / HOUR_MS))
  })

  it('a trip exactly at the maximum is not clamped', () => {
    const start = Date.UTC(2026, 5, 1, 10, 0)
    expect(computeHourBuckets(start, start + MAX_TRIP_HOUR_BUCKETS * HOUR_MS)).toHaveLength(
      MAX_TRIP_HOUR_BUCKETS,
    )
  })

  it('never returns buckets for a non-finite start', () => {
    expect(computeHourBuckets(Number.NaN, Date.now())).toEqual([])
  })

  it('a reversed range yields one bucket, never a negative count', () => {
    const start = Date.UTC(2026, 5, 1, 10, 0)
    expect(computeHourBuckets(start, start - 10 * HOUR_MS)).toHaveLength(1)
  })
})
