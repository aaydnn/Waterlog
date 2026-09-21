import type { Pattern } from '@waterlog/patterns'
import { ulid } from 'ulid'

/**
 * Writing a scope's patterns back to `pattern_cache`.
 *
 * One scope is replaced in a single `db.batch`, which D1 runs as one transaction. A reader that
 * arrives mid-recompute sees either last night's feed or tonight's, never half of each — the
 * pattern feed is the product's retention moment and a flickering one would be worse than a stale
 * one.
 */

const INSERT_SQL = `
  INSERT INTO pattern_cache
    (id, user_id, scope, dimension, bucket, catches, hours, rate, baseline_rate, multiplier,
     confidence, trips, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export async function replaceScope(
  db: D1Database,
  userId: string,
  scope: string,
  patterns: Pattern[],
  computedAt: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM pattern_cache WHERE user_id = ? AND scope = ?').bind(userId, scope),
  ]
  for (const pattern of patterns) {
    statements.push(
      db
        .prepare(INSERT_SQL)
        .bind(
          ulid(),
          userId,
          pattern.scope,
          pattern.dimension,
          pattern.bucket,
          pattern.catches,
          pattern.hours,
          pattern.rate,
          pattern.baseline_rate,
          pattern.multiplier,
          pattern.confidence,
          pattern.trips,
          computedAt,
        ),
    )
  }
  await db.batch(statements)
}

/** Scopes this angler has cached rows for that tonight's run no longer produces — a water they
 * stopped fishing, or one that fell back under the baseline minimum. Left behind, they would read
 * as current. */
export async function pruneScopes(
  db: D1Database,
  userId: string,
  keep: string[],
): Promise<number> {
  // `NOT IN ()` is a syntax error, and an empty keep list means keep nothing.
  if (keep.length === 0) {
    const wiped = await db.prepare('DELETE FROM pattern_cache WHERE user_id = ?').bind(userId).run()
    return wiped.meta.changes
  }
  const placeholders = keep.map(() => '?').join(', ')
  const result = await db
    .prepare(`DELETE FROM pattern_cache WHERE user_id = ? AND scope NOT IN (${placeholders})`)
    .bind(userId, ...keep)
    .run()
  return result.meta.changes
}

export interface RunProgress {
  cursor: string | null
  patternCount: number
  unattributedCatches: number
  completed: boolean
}

/** The recompute's own bookkeeping: where it got to, and what it found. */
export async function recordRun(
  db: D1Database,
  userId: string,
  progress: RunProgress,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pattern_runs (user_id, completed_at, cursor, pattern_count, unattributed_catches, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         completed_at = excluded.completed_at,
         cursor = excluded.cursor,
         pattern_count = excluded.pattern_count,
         unattributed_catches = excluded.unattributed_catches,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      progress.completed ? now : null,
      progress.cursor,
      progress.patternCount,
      progress.unattributedCatches,
      now,
    )
    .run()
}
