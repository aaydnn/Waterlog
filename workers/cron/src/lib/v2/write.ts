import { parseFindingKey, toPersisted, type EngineResult, type Finding } from '@waterlog/pattern-engine'

/**
 * Persisting a v2 run: findings, hypothesis verdicts, and the run blob (ADR-0017, brief §5).
 *
 * Everything goes in one `db.batch`, which D1 runs as a single transaction. A reader arriving
 * mid-run sees last night's findings or tonight's, never half of each — the same rule the v1
 * writer holds for `pattern_cache`, for the same reason.
 */

/**
 * One row per **record**, not per finding.
 *
 * The distinction is the whole point of the table. A `Finding` is what the feed shows *this* run;
 * a `FindingRecord` is the lifecycle that survives between runs — when it was discovered, what it
 * has done since, what changed the engine's mind. A finding that stops being surfaced keeps its
 * record with `finding_json = NULL`, so next time it reappears it is a revival with a history
 * rather than a discovery.
 */
const UPSERT_FINDING_SQL = `
  INSERT INTO pattern_findings
    (user_id, key, scope, outcome, dimension, bucket, direction, tier, lifecycle, multiplier,
     finding_json, record_json, engine_version, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET
    scope = excluded.scope,
    outcome = excluded.outcome,
    dimension = excluded.dimension,
    bucket = excluded.bucket,
    direction = excluded.direction,
    tier = excluded.tier,
    lifecycle = excluded.lifecycle,
    multiplier = excluded.multiplier,
    finding_json = excluded.finding_json,
    record_json = excluded.record_json,
    engine_version = excluded.engine_version,
    computed_at = excluded.computed_at`

const UPDATE_HYPOTHESIS_SQL = `
  UPDATE hypotheses SET result_json = ?, updated_at = ? WHERE id = ? AND user_id = ?`

/**
 * The run blob, written **without touching v1's columns**.
 *
 * `pattern_runs` is keyed by `user_id` and shared with the v1 recompute, whose nightly sweep picks
 * anglers by `completed_at`. If this wrote that column, a v2 run would mark the angler done and
 * v1 would skip them — the two engines would silently starve each other. So v2 owns `result_json`,
 * `engine_version` and `computed_at` (added by migration 0010 for exactly this reason), and leaves
 * `completed_at`, `cursor` and `pattern_count` to v1.
 *
 * The INSERT arm supplies v1's NOT NULL columns from their defaults; the UPDATE arm does not
 * mention them at all.
 */
const UPSERT_RUN_SQL = `
  INSERT INTO pattern_runs
    (user_id, result_json, engine_version, computed_at, updated_at, pattern_count, unattributed_catches)
  VALUES (?, ?, ?, ?, ?, 0, 0)
  ON CONFLICT(user_id) DO UPDATE SET
    result_json = excluded.result_json,
    engine_version = excluded.engine_version,
    computed_at = excluded.computed_at,
    updated_at = excluded.updated_at`

export interface WriteSummary {
  /** Records written this run, surfaced or not. */
  records: number
  /** Records carrying a surfaced finding — what an angler would actually see. */
  surfaced: number
  hypotheses: number
}

/**
 * Write a whole run.
 *
 * `toPersisted` trims each finding's trip receipts to the ten most supporting and ten most
 * contrary before anything reaches D1, because the full contribution list grows with the angler's
 * history and the receipt only ever shows a handful.
 */
export async function writeEngineResult(
  db: D1Database,
  userId: string,
  result: EngineResult,
  now: number,
): Promise<WriteSummary> {
  const persisted = toPersisted(result)

  // Findings are keyed the same way records are, so the two are matched by key rather than by
  // position: the engine surfaces a subset of what it tracks, and the orders do not line up.
  const findings = new Map<string, Finding>()
  for (const family of persisted.families) {
    for (const finding of family.findings) findings.set(finding.key, finding)
  }

  const statements: D1PreparedStatement[] = []

  for (const record of persisted.records) {
    const finding = findings.get(record.key)
    // A surfaced finding carries its own scope/outcome/dimension/bucket; a record without one this
    // run has only its key, and the engine owns that format.
    const parts = finding
      ? {
          scopeId: finding.scopeId,
          outcome: finding.outcome,
          dimension: finding.stats.dimension,
          bucket: finding.stats.bucket,
        }
      : parseFindingKey(record.key)

    statements.push(
      db
        .prepare(UPSERT_FINDING_SQL)
        .bind(
          userId,
          record.key,
          parts.scopeId,
          parts.outcome,
          parts.dimension,
          parts.bucket,
          record.direction,
          record.tier,
          record.state,
          record.multiplier,
          finding ? JSON.stringify(finding) : null,
          JSON.stringify(record),
          record.engineVersion,
          now,
        ),
    )
  }

  for (const verdict of persisted.hypotheses) {
    // Scoped by user_id as well as id: a hypothesis id arriving from anywhere but this angler's
    // own rows must update nothing rather than someone else's notebook.
    statements.push(
      db.prepare(UPDATE_HYPOTHESIS_SQL).bind(JSON.stringify(verdict), now, verdict.id, userId),
    )
  }

  statements.push(
    db
      .prepare(UPSERT_RUN_SQL)
      .bind(userId, JSON.stringify(persisted), persisted.engineVersion, persisted.computedAt, now),
  )

  await db.batch(statements)

  return {
    records: persisted.records.length,
    surfaced: persisted.records.filter((r) => findings.has(r.key)).length,
    hypotheses: persisted.hypotheses.length,
  }
}
