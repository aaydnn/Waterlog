import { enrichJobSchema } from '@waterlog/schema'
import { enrichCatch, enrichTripHours } from './lib/conditions'
import type { EnrichBindings } from './env'

// Five total attempts: initial delivery plus four retries (wrangler.toml).
const MAX_ATTEMPTS = 5

function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** (attempt - 1), 300)
}

export default {
  async queue(batch: MessageBatch<unknown>, env: EnrichBindings): Promise<void> {
    for (const message of batch.messages) {
      const parsed = enrichJobSchema.safeParse(message.body)
      if (!parsed.success) {
        // Malformed message: nothing productive to retry, drop it rather than poison-pill loop.
        console.error('enrich: dropping malformed message', message.id, parsed.error.message)
        message.ack()
        continue
      }

      const job = parsed.data
      try {
        const status = job.type === 'catch'
          ? await enrichCatch(env.DB, fetch, job.catch_id, env.USGS_API_KEY)
          : await enrichTripHours(env.DB, fetch, job.trip_id, job.hour_buckets, env.USGS_API_KEY)
        if (status === 'partial' && message.attempts < MAX_ATTEMPTS) {
          message.retry({ delaySeconds: backoffSeconds(message.attempts) })
          continue
        }
        message.ack()
      } catch (err) {
        console.error('enrich: job failed', message.id, err)
        if (message.attempts < MAX_ATTEMPTS) {
          message.retry({ delaySeconds: backoffSeconds(message.attempts) })
          continue
        }
        // Retries exhausted: a catch has a status column to mark terminal; a trip-hours job
        // doesn't (conditions rows just stay absent for whichever buckets never got written).
        if (job.type === 'catch') {
          await env.DB
            .prepare("UPDATE catches SET enrich_status = 'partial', updated_at = ? WHERE id = ?")
            .bind(Date.now(), job.catch_id)
            .run()
            .catch((updateErr) => console.error('enrich: failed to record terminal status', updateErr))
        }
        message.ack()
      }
    }
  },
}
