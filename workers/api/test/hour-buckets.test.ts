import { describe, expect, it } from 'vitest'
import { computeHourBuckets } from '../src/lib/hour-buckets'

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
