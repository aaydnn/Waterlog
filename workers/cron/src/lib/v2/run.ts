import type { Pattern } from '@waterlog/patterns'
import { runEngine, type EngineResult, type LifecycleState } from '@waterlog/pattern-engine'
import { pruneScopes, recordRun, replaceScope } from '../write'
import { v2ToPatternCache } from './adapter'
import { loadEngineInput } from './load'
import { writeEngineResult, type WriteSummary } from './write'

/**
 * One angler through the v2 engine (ADR-0017, brief §5).
 *
 * Load, compute, persist. No chunking and no cursor: v1 walks scopes against a row budget because
 * it shares one invocation across a whole feed, but v2 gets one message per angler and measures
 * roughly 60ms at 40 trips and 210ms at 300, so it runs to completion with the Worker's
 * `limits.cpu_ms` as the backstop rather than a budget of its own.
 *
 * **Shadow or primary.** In shadow v2 writes only its own tables and the angler sees v1's feed. As
 * primary it also projects onto `pattern_cache`, claims `pattern_runs.completed_at`, and owns the
 * first-pattern push. Which one is live is a deployment decision, not a code one — see
 * `PATTERN_ENGINE_VERSION` in `env.ts`.
 */

/**
 * Brief §5: the push fires on the first record reaching a state that means something held up.
 * `hypothesis` is explicitly not one of them — it is the engine's own shortlist, not a claim, and
 * announcing it would spend the one push an angler ever gets on a maybe.
 */
const NOTIFIABLE: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'emerging',
  'repeated',
  'confirmed',
])

export interface RunOutcome extends WriteSummary {
  trips: number
  hours: number
  catches: number
  /** True when the angler has too little exposure for the engine to say anything. Not a failure —
   * the correct answer to three hours of fishing is nothing at all. */
  empty: boolean
  /** Rows projected onto `pattern_cache`. Zero in shadow, where the feed stays v1's. */
  feedRows: number
  /** This run found something worth telling the angler about. The once-ever guard lives in the
   * database, so this is a nomination rather than a decision. */
  firstPattern: boolean
}

export interface RunOptions {
  /**
   * Primary means v2 owns what the angler sees. Default false: landing the engine and handing it
   * the feed are separate decisions, and the second one is reversible by flipping a var.
   */
  primary?: boolean
}

export async function runEngineForUser(
  db: D1Database,
  userId: string,
  now: number,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const input = await loadEngineInput(db, userId, now)
  const result = runEngine(input)
  const written = await writeEngineResult(db, userId, result, now)

  const base = {
    ...written,
    trips: input.trips.length,
    hours: input.conditions.length,
    catches: input.catches.length,
    empty: result.families.length === 0,
  }

  if (!options.primary) return { ...base, feedRows: 0, firstPattern: false }

  const feedRows = await publishFeed(db, userId, result, now)
  return {
    ...base,
    feedRows,
    firstPattern: result.records.some((r) => NOTIFIABLE.has(r.state)),
  }
}

/**
 * Project the run onto `pattern_cache`, which is what the shipped feed reads.
 *
 * Deliberately reuses v1's writers rather than growing a second set of statements against the same
 * table: `replaceScope` swaps one scope inside a single transaction, so a reader mid-run sees last
 * night's feed or tonight's and never half of each, and `pruneScopes` clears the waters this run
 * no longer produces. Those properties are the reason the feed does not flicker, and they should
 * not have to be re-established per engine.
 */
async function publishFeed(
  db: D1Database,
  userId: string,
  result: EngineResult,
  now: number,
): Promise<number> {
  const rows = v2ToPatternCache(result)

  const byScope = new Map<string, Pattern[]>()
  for (const row of rows) {
    const list = byScope.get(row.scope)
    if (list) list.push(row)
    else byScope.set(row.scope, [row])
  }

  // Every scope the engine looked at, not just the ones that produced a card. A water that used to
  // have patterns and no longer does has to be emptied, or last month's cards read as current.
  const scopes = new Set<string>(byScope.keys())
  for (const family of result.families) {
    if (family.outcome === 'all') scopes.add(family.scopeId)
  }

  for (const scope of [...scopes].sort()) {
    await replaceScope(db, userId, scope, byScope.get(scope) ?? [], now)
  }
  await pruneScopes(db, userId, [...scopes])

  // `completed_at` is what the nightly sweep picks anglers by. In shadow it stays v1's to claim;
  // as primary v2 has to claim it, or every angler would look permanently overdue.
  await recordRun(
    db,
    userId,
    { cursor: null, patternCount: rows.length, unattributedCatches: 0, completed: true },
    now,
  )

  return rows.length
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
export function logRun(userId: string, outcome: RunOutcome, primary: boolean): void {
  console.log(
    'cron: v2 engine',
    JSON.stringify({
      user: userId,
      mode: primary ? 'primary' : 'shadow',
      trips: outcome.trips,
      hours: outcome.hours,
      catches: outcome.catches,
      records: outcome.records,
      surfaced: outcome.surfaced,
      feedRows: outcome.feedRows,
      empty: outcome.empty,
    }),
  )
}
