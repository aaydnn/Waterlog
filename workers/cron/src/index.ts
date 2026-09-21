import { patternEngineJobSchema, patternJobSchema } from '@waterlog/schema'
import type { CronBindings } from './env'
import { computePatterns } from '@waterlog/patterns'
import { runEngine } from '@waterlog/pattern-engine'
import { loadHistory, usersDueForRecompute } from './lib/load'
import { recomputeUser } from './lib/recompute'
import { announceFirstPattern } from './lib/notify'
import { loadEngineInput } from './lib/v2/load'
import { compareEngines, formatParityReport } from './lib/v2/parity'
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
    const v2Primary = isV2Primary(env)

    for (const userId of due) {
      if (v2Primary) {
        // v2 owns the feed. v1 is not enqueued at all — two engines writing `pattern_cache` would
        // overwrite each other nightly, and whichever finished last would win by accident.
        await env.ENGINE_QUEUE.send({ user_id: userId, trip_id: null })
        continue
      }

      // trip_id is null on the nightly sweep: a post-trip run is the only thing that names a trip.
      await env.PATTERN_QUEUE.send({ user_id: userId, cursor: null, trip_id: null })
      // The same angler goes to v2 as well, in shadow: it writes `pattern_findings` and never
      // `pattern_cache`, so both engines see the same night and the parity gate has two outputs to
      // compare. A shadow enqueue that fails must not cost the angler their real feed, so it is
      // best-effort and the sweep carries on.
      await env.ENGINE_QUEUE.send({ user_id: userId, trip_id: null }).catch((err) =>
        console.error('cron: could not enqueue v2 run for', userId, err),
      )
    }

    console.log(
      'cron: enqueued pattern recompute for',
      due.length,
      'anglers at',
      new Date(now).toISOString(),
      v2Primary ? '(v2 primary)' : '(v1 primary, v2 shadow)',
    )
  },

  /**
   * The parity harness (brief §7), and nothing else.
   *
   * This worker has no business serving requests, so the only route exists to run both engines
   * over one angler's real history and print the comparison. It is off unless
   * `ALLOW_PARITY_ROUTE` is set, which `wrangler.toml` never does — see `env.ts`.
   *
   *   cd workers/cron
   *   pnpm exec wrangler dev --persist-to ../../.wrangler-local --port 8799
   *   curl "http://127.0.0.1:8799/__parity?user=<user_id>"
   */
  async fetch(request: Request, env: CronBindings): Promise<Response> {
    const url = new URL(request.url)
    if (env.ALLOW_PARITY_ROUTE !== 'true' || url.pathname !== '/__parity') {
      return new Response('Not found', { status: 404 })
    }

    const userId = url.searchParams.get('user')
    if (!userId) return new Response('Pass ?user=<user_id>\n', { status: 400 })

    const [v1, v2Input] = await Promise.all([
      loadHistory(env.DB, userId),
      loadEngineInput(env.DB, userId, Date.now()),
    ])
    const report = compareEngines(computePatterns(v1).patterns, runEngine(v2Input))

    return new Response(formatParityReport(report) + '\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
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

/** The cutover, read in one place. Anything but the exact string leaves v1 in charge, so a typo in
 * a deploy var fails safe: the angler keeps the feed that has been working. */
function isV2Primary(env: CronBindings): boolean {
  return env.PATTERN_ENGINE_VERSION === 'v2'
}

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
    const primary = isV2Primary(env)
    try {
      const outcome = await runEngineForUser(env.DB, job.user_id, Date.now(), { primary })
      logRun(job.user_id, outcome, primary)

      if (primary && outcome.firstPattern) {
        // Best-effort, like every other outbound call in this product: a push that fails must not
        // undo a recompute that succeeded. The once-ever guard is a conditional UPDATE in the
        // database, so a redelivered message cannot produce a second announcement.
        await announceFirstPattern(env, job.user_id).catch((err) =>
          console.error('cron: first-pattern push failed for', job.user_id, err),
        )
      }

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
