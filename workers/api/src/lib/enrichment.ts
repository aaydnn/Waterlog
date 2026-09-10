import type { EnrichJob, Trip } from '@waterlog/schema'
import { computeHourBuckets } from './hour-buckets'

/** Rolling window the per-account dispatch budget is measured over. */
export const DISPATCH_WINDOW_MS = 24 * 60 * 60 * 1000
/**
 * Enrichment jobs one account may dispatch per rolling day. A first sync after a season offline
 * is a few hundred rows; 1,000 leaves that headroom while stopping a scripted client from
 * turning cheap writes into unbounded outbound weather/gauge fetches. Over budget we skip the
 * send rather than fail the write: capture is never blocked and enrichment is best-effort
 * (packet §06). No receipt is written for a skipped job, so a later sync re-dispatches it once
 * the window has rolled off.
 */
export const MAX_DISPATCHES_PER_WINDOW = 1000

/** A request-scoped allowance, so the count query runs once per request, not once per row. */
export interface DispatchBudget {
  remaining: number
}

export async function dispatchBudget(
  db: D1Database,
  userId: string,
  now: number = Date.now(),
): Promise<DispatchBudget> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM enrichment_dispatches WHERE user_id = ? AND created_at > ?')
    .bind(userId, now - DISPATCH_WINDOW_MS)
    .first<{ n: number }>()
  return { remaining: Math.max(0, MAX_DISPATCHES_PER_WINDOW - (row?.n ?? 0)) }
}

/** Receipts are saved only after Queues accepts the job. Replayed HTTP requests
 * repair failed sends; concurrent requests may safely deliver duplicate jobs. */
export async function enqueueEnrichment(
  db: D1Database,
  queue: Queue<EnrichJob>,
  userId: string,
  job: EnrichJob,
  budget?: DispatchBudget,
): Promise<void> {
  const key = job.type === 'catch' ? `catch:${job.catch_id}` : `trip_hours:${job.trip_id}`
  const sent = await db.prepare('SELECT job_key FROM enrichment_dispatches WHERE job_key = ? AND user_id = ?')
    .bind(key, userId).first()
  if (sent) return
  if (budget && budget.remaining <= 0) {
    console.warn('enrichment: dispatch budget exhausted for user', userId, 'skipping', key)
    return
  }
  await queue.send(job)
  if (budget) budget.remaining -= 1
  await db.prepare('INSERT INTO enrichment_dispatches (job_key, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(job_key) DO NOTHING')
    .bind(key, userId, Date.now()).run()
}

export async function enqueueTripHours(
  db: D1Database,
  queue: Queue<EnrichJob>,
  trip: Trip,
  budget?: DispatchBudget,
): Promise<void> {
  if (trip.ended_at === null) return
  await enqueueEnrichment(db, queue, trip.user_id, {
    type: 'trip_hours', trip_id: trip.id,
    // Clamped to MAX_TRIP_HOUR_BUCKETS: one job can never fan out past a day's worth of lookups.
    hour_buckets: computeHourBuckets(trip.started_at, trip.ended_at),
  }, budget)
}
