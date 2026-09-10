const HOUR_MS = 60 * 60 * 1000

/**
 * Hard ceiling on the buckets one trip may generate, and therefore on the enrichment work a
 * single trip can ask for: one bucket is one `conditions` row and one weather/gauge lookup in
 * the enrich worker. 48 = the longest trip we accept (see `MAX_TRIP_DURATION_MS`), which is
 * already double the 24h an overnight outing runs and 8× the 6h idle auto-close in packet §04 F2.
 */
export const MAX_TRIP_HOUR_BUCKETS = 48

/**
 * Epoch-hour buckets an ended trip should get a `conditions` row for (packet §07/§10). Anchored
 * to the trip's own start rather than wall-clock hour boundaries, so a 4.5h trip always yields
 * exactly 5 buckets regardless of what minute it started.
 *
 * Clamps rather than throws. Trip times are validated at the edge (`validateTripTimes`), so an
 * over-long trip reaching here is either a row written before that validation existed or a
 * caller that skipped it; enrichment is best-effort (packet §06), so bounding the work is the
 * right failure — a thrown error would 500 a sync whose rows are already persisted.
 */
export function computeHourBuckets(startedAt: number, endedAt: number): number[] {
  const firstBucket = Math.floor(startedAt / HOUR_MS)
  if (!Number.isFinite(firstBucket)) return []
  const durationMs = Math.max(0, endedAt - startedAt)
  const wanted = !Number.isFinite(durationMs) || durationMs === 0 ? 1 : Math.ceil(durationMs / HOUR_MS)
  const bucketCount = Math.min(wanted, MAX_TRIP_HOUR_BUCKETS)
  return Array.from({ length: bucketCount }, (_, i) => firstBucket + i)
}
