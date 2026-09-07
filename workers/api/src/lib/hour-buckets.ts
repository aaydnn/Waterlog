const HOUR_MS = 60 * 60 * 1000

/**
 * Epoch-hour buckets an ended trip should get a `conditions` row for (packet §07/§10). Anchored
 * to the trip's own start rather than wall-clock hour boundaries, so a 4.5h trip always yields
 * exactly 5 buckets regardless of what minute it started.
 */
export function computeHourBuckets(startedAt: number, endedAt: number): number[] {
  const durationMs = Math.max(0, endedAt - startedAt)
  const bucketCount = durationMs === 0 ? 1 : Math.ceil(durationMs / HOUR_MS)
  const firstBucket = Math.floor(startedAt / HOUR_MS)
  return Array.from({ length: bucketCount }, (_, i) => firstBucket + i)
}
