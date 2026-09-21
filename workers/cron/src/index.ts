import { patternEngineJobSchema, patternJobSchema } from '@waterlog/schema'
import type { CronBindings } from './env'
import { usersDueForRecompute } from './lib/load'
import { recomputeUser } from './lib/recompute'
import { announceFirstPattern } from './lib/notify'
import { logRun, runEngineForUser } from './lib/v2/run'

/**
 * The nightly pattern recompute (packet §05/§10).
 *
 * The scheduled handler does no arithmetic. It finds the anglers who are due and puts one message
 * on the queue for each, and the consumer computes one angler per message. That split is what
 * gives every angler their own CPU allowance, their own retry, and a natural place to stop and
 * resume — none of which a single long invocation walking every user could offer.
 */

/** Anglers enqueued per nightly run. A cron trigger has its own time limit, so the sweep stays a
 * bounded amount of queue writes; the rest are picked up by the next run, oldest first. */
const MAX_USERS_PER_RUN = 5_000

/** How stale a completed run has to be before it is recomputed. Just under a day, so a nightly
 * trigger that drifts by a few minutes still re-runs everyone. */
const RECOMPUTE_AFTER_MS = 20 * 60 * 60 * 1000

/** Initial delivery plus four retries, matching the enrich worker's shape. */
const MAX_ATTEMPTS = 5

function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** (attempt - 1), 300)
}

export default {
  async scheduled(event: ScheduledController, env: CronBindings): Promise<void> {
    const now = event.scheduledTime
    const due = await usersDueForRecompute(env.DB, now - RECOMPUTE_AFTER_MS, MAX_USERS_PER_RUN)
    for (const userId of due) {
      // trip_id is null on the nightly sweep: a post-trip run is the only thing that names a trip.
      await env.PATTERN_QUEUE.send({ user_id: userId, cursor: null, trip_id: null })
      // The same angler goes to v2 as well. It runs in shadow — it writes `pattern_findings` and
      // never `pattern_cache` — so both engines see the same night's history and the parity gate
      // has two outputs to compare. A v2 enqueue that fails must not cost the angler their v1
      // feed, so it is best-effort and the sweep carries on.
      await env.ENGINE_QUEUE.send({ user_id: userId, trip_id: null }).catch((err) =>
        console.error('cron: could not enqueue v2 run for', userId, err),
      )
    }
    console.log('cron: enqueued pattern recompute for', due.length, 'anglers at', new Date(now).toISOString())
  },

  async queue(batch: MessageBatch<unknown>, env: CronBindings): Promise<void> {
    // One Worker, two queues. Dispatching on the queue name rather than on a field in the body
    // keeps the two engines' message shapes independent: v2 has no cursor and never will, and v1
    // should not grow a discriminator it does not need.
    if (batch.queue === ENGINE_QUEUE_NAME) return handleEngineBatch(batch, env)
    return handleV1Batch(batch, env)
  },
}

/** Must match the queue name in wrangler.toml. */
const ENGINE_QUEUE_NAME = 'pattern-engine'

async function handleV1Batch(batch: MessageBatch<unknown>, env: CronBindings): Promise<void> {
    for (const message of batch.messages) {
      const parsed = patternJobSchema.safeParse(message.body)
      if (!parsed.success) {
        // Nothing productive to retry on a malformed message; dropping beats a poison-pill loop.
        console.error('cron: dropping malformed pattern job', message.id, parsed.error.message)
        message.ack()
        continue
      }

      const job = parsed.data
      try {
        const outcome = await recomputeUser(env.DB, job.user_id, job.cursor, Date.now())

        if (!outcome.completed) {
          // Out of budget with scopes left. The cursor is already recorded, so the follow-up
          // message is a resume, not a restart.
          await env.PATTERN_QUEUE.send({ user_id: job.user_id, cursor: outcome.cursor, trip_id: job.trip_id })
        } else if (outcome.firstPattern) {
          // Best-effort, like every other outbound call in this product: a push that fails must
          // not undo a recompute that succeeded.
          await announceFirstPattern(env, job.user_id).catch((err) =>
            console.error('cron: first-pattern push failed for', job.user_id, err),
          )
        }

        message.ack()
      } catch (err) {
        console.error('cron: recompute failed for', job.user_id, err)
        if (message.attempts < MAX_ATTEMPTS) {
          message.retry({ delaySeconds: backoffSeconds(message.attempts) })
          continue
        }
        // Retries exhausted. The angler keeps last night's feed, which is stale rather than wrong,
        // and tomorrow's sweep will pick them up again.
        message.ack()
      }
    }
}

/**
 * The v2 engine's consumer (ADR-0017).
 *
 * Shadow mode: this writes `pattern_findings`, `hypotheses.result_json` and the v2 columns of
 * `pattern_runs`, and touches nothing the angler reads. The first-pattern push stays with v1 for
 * the same reason — two engines announcing the same discovery would send two notifications for
 * one event, and v2's lifecycle states are not yet the ones the feed is built on.
 */
async function handleEngineBatch(batch: MessageBatch<unknown>, env: CronBindings): Promise<void> {
  for (const message of batch.messages) {
    const parsed = patternEngineJobSchema.safeParse(message.body)
    if (!parsed.success) {
      console.error('cron: dropping malformed engine job', message.id, parsed.error.message)
      message.ack()
      continue
    }

    const job = parsed.data
    try {
      const outcome = await runEngineForUser(env.DB, job.user_id, Date.now())
      logRun(job.user_id, outcome)
      message.ack()
    } catch (err) {
      console.error('cron: v2 engine failed for', job.user_id, err)
      if (message.attempts < MAX_ATTEMPTS) {
        message.retry({ delaySeconds: backoffSeconds(message.attempts) })
        continue
      }
      // Retries exhausted. Nothing an angler can see is affected while v2 runs in shadow, and the
      // records it already holds stay as they were rather than being half-rewritten — the write is
      // a single batch, so a failed run leaves last night's state intact.
      message.ack()
    }
  }
}
