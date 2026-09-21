import { computePatterns, scopesIn } from '@waterlog/patterns'
import { loadHistory } from './load'
import { pruneScopes, recordRun, replaceScope } from './write'

/**
 * One angler's nightly recompute, chunked.
 *
 * Packet §10 asks for a 50ms budget per user or a re-queue. Wall-clock time is the wrong
 * instrument for it: inside a Worker both `Date.now()` and `performance.now()` advance only across
 * I/O, so a pure-CPU loop — which is exactly what the engine is — sees no time pass at all and a
 * timer-based budget would never fire. So the budget is measured in the work itself: rows fed
 * through the engine. It is deterministic, it is testable, and it cuts in the same place every
 * time, which a clock in a shared runtime would not.
 *
 * The unit of chunking is the scope. Scopes are independent, each is replaced in its own
 * transaction, and the cursor is just which one to resume at.
 */

/**
 * Rows one message will push through the engine before handing the rest back to the queue. The
 * engine walks nine dimensions plus three pairs over each scope, so this is a few million bucket
 * operations — comfortably inside a Worker's CPU allowance, with room for the scope that turns
 * out to be bigger than the estimate.
 */
export const ROW_BUDGET = 60_000

export interface RecomputeOutcome {
  /** Scopes written by this message. */
  scopes: string[]
  /** Scope to resume at, or null when the angler is finished. */
  cursor: string | null
  completed: boolean
  patternCount: number
  unattributedCatches: number
  /** True when this run is the first to find a pattern worth telling the angler about. */
  firstPattern: boolean
}

/** Packet §09 flow 3 pushes on the first promising-or-better pattern. (Its §08 table says solid;
 * the two disagree, and promising is the one the flow spec names — it arrives while the angler is
 * still forming the habit, and the card says "Promising" on its face, so nothing is oversold.) */
const NOTIFIABLE = new Set(['promising', 'solid'])

export interface RecomputeOptions {
  /** Overrides `ROW_BUDGET`. Exists so the chunking can be exercised against a handful of rows
   * rather than the tens of thousands the production budget implies. */
  rowBudget?: number
}

export async function recomputeUser(
  db: D1Database,
  userId: string,
  cursor: string | null,
  now: number,
  options?: RecomputeOptions,
): Promise<RecomputeOutcome> {
  const budget = options?.rowBudget ?? ROW_BUDGET
  const history = await loadHistory(db, userId)
  const scopes = [...scopesIn(history.hours)].sort()

  // An unknown cursor (a scope that vanished since the run was queued) restarts the angler rather
  // than skipping the rest of them.
  const resumeAt = cursor === null ? 0 : Math.max(0, scopes.indexOf(cursor))

  let spent = 0
  let unattributed = 0
  let firstPattern = false
  let index = resumeAt
  const written: string[] = []

  while (index < scopes.length && spent < budget) {
    const scope = scopes[index]!
    const report = computePatterns(history, { scopes: [scope] })
    await replaceScope(db, userId, scope, report.patterns, now)
    if (report.patterns.some((p) => NOTIFIABLE.has(p.confidence))) firstPattern = true
    unattributed = report.unattributed_catches
    spent += history.hours.length
    written.push(scope)
    index += 1
  }

  const completed = index >= scopes.length
  if (completed) await pruneScopes(db, userId, scopes)

  const patternCount = await countPatterns(db, userId)
  await recordRun(
    db,
    userId,
    {
      cursor: completed ? null : scopes[index]!,
      patternCount,
      unattributedCatches: unattributed,
      completed,
    },
    now,
  )

  return {
    scopes: written,
    cursor: completed ? null : scopes[index]!,
    completed,
    patternCount,
    unattributedCatches: unattributed,
    firstPattern: firstPattern && completed,
  }
}

async function countPatterns(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
    .bind(userId)
    .first<{ n: number }>()
  return row?.n ?? 0
}
