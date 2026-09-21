import { runEngine } from '@waterlog/pattern-engine'
import { loadEngineInput } from './load'
import { writeEngineResult, type WriteSummary } from './write'

/**
 * One angler through the v2 engine (ADR-0017, brief §5).
 *
 * Load, compute, persist. No chunking and no cursor: v1 walks scopes against a row budget because
 * it shares one invocation across a whole feed, but v2 gets one message per angler and measures
 * roughly 60ms at 40 trips and 210ms at 300, so it runs to completion with the Worker's
 * `limits.cpu_ms` as the backstop rather than a budget of its own.
 */

export interface RunOutcome extends WriteSummary {
  trips: number
  hours: number
  catches: number
  /** True when the angler has too little exposure for the engine to say anything. Not a failure —
   * the correct answer to three hours of fishing is nothing at all. */
  empty: boolean
}

export async function runEngineForUser(
  db: D1Database,
  userId: string,
  now: number,
): Promise<RunOutcome> {
  const input = await loadEngineInput(db, userId, now)
  const result = runEngine(input)
  const written = await writeEngineResult(db, userId, result, now)

  return {
    ...written,
    trips: input.trips.length,
    hours: input.conditions.length,
    catches: input.catches.length,
    empty: result.families.length === 0,
  }
}

/**
 * What a run reports about itself.
 *
 * Brief §5 asks for CPU ms per user here, and that number cannot be obtained. Inside a Worker both
 * `Date.now()` and `performance.now()` advance only across I/O, so timing a pure-CPU engine run
 * returns zero however it is measured — the same fact that made Epic 4's per-user budget a row
 * budget rather than a timer (see `docs/epic-4-acceptance.md`).
 *
 * So this logs the things that actually drive the cost and can be read honestly: how much history
 * went in, and how much came out. If a run starts hitting the CPU limit, these are the numbers
 * that say which angler and how much of what. Real CPU time is available per request in the
 * Cloudflare dashboard and in Workers Analytics, which is where a p95 should come from.
 */
export function logRun(userId: string, outcome: RunOutcome): void {
  console.log(
    'cron: v2 engine',
    JSON.stringify({
      user: userId,
      trips: outcome.trips,
      hours: outcome.hours,
      catches: outcome.catches,
      records: outcome.records,
      surfaced: outcome.surfaced,
      empty: outcome.empty,
    }),
  )
}
