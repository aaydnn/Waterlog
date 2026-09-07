import type { EnrichJob, Trip } from '@waterlog/schema'
import { computeHourBuckets } from './hour-buckets'

/** Receipts are saved only after Queues accepts the job. Replayed HTTP requests
 * repair failed sends; concurrent requests may safely deliver duplicate jobs. */
export async function enqueueEnrichment(db: D1Database, queue: Queue<EnrichJob>, userId: string, job: EnrichJob): Promise<void> {
  const key = job.type === 'catch' ? `catch:${job.catch_id}` : `trip_hours:${job.trip_id}`
  const sent = await db.prepare('SELECT job_key FROM enrichment_dispatches WHERE job_key = ? AND user_id = ?')
    .bind(key, userId).first()
  if (sent) return
  await queue.send(job)
  await db.prepare('INSERT INTO enrichment_dispatches (job_key, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(job_key) DO NOTHING')
    .bind(key, userId, Date.now()).run()
}

export async function enqueueTripHours(db: D1Database, queue: Queue<EnrichJob>, trip: Trip): Promise<void> {
  if (trip.ended_at === null) return
  await enqueueEnrichment(db, queue, trip.user_id, {
    type: 'trip_hours', trip_id: trip.id,
    hour_buckets: computeHourBuckets(trip.started_at, trip.ended_at),
  })
}
