import type { CatchEvent, ExposureHour } from '@waterlog/patterns'

/**
 * Reading one angler's history out of D1 in the shape the engine wants.
 *
 * The engine is pure and does no I/O, so everything it needs is fetched here and handed over
 * whole. Both queries are scoped by `user_id` — single-tenant-per-row, packet §07 — and both are
 * bounded, because "how much data does one angler have" is not a question this worker should
 * discover at runtime.
 */

/**
 * Ceiling on the hours one recompute will load. Fifty thousand hours is more than five years of
 * continuous fishing; anything past it is a data fault, not a season, and it is better to compute
 * a correct answer on the most recent history than to run a Worker out of memory.
 */
export const MAX_HOURS_PER_USER = 50_000

/** Open trips are excluded from both sides: they have no `ended_at`, so they have generated no
 * hour buckets, and counting their catches against nothing would invent a rate. Their fish come
 * back in `unattributed_catches` instead. */
const HOURS_SQL = `
  SELECT c.trip_id, t.water_body_id, c.hour_bucket, c.pressure_trend, c.cloud_pct, c.wind_kph,
         c.water_temp_c, c.moon_phase, c.minutes_from_sunrise, c.season
  FROM conditions c
  JOIN trips t ON t.id = c.trip_id AND t.user_id = c.user_id
  WHERE c.user_id = ? AND c.trip_id IS NOT NULL AND c.hour_bucket IS NOT NULL
    AND t.deleted_at IS NULL AND t.ended_at IS NOT NULL
  ORDER BY c.hour_bucket DESC
  LIMIT ?`

const CATCHES_SQL = `
  SELECT ca.id, ca.trip_id, ca.caught_at, l.family AS lure_family, l.color AS lure_color
  FROM catches ca
  JOIN trips t ON t.id = ca.trip_id AND t.user_id = ca.user_id
  -- Owner-scoped, like the journal's joins: a lure_id pointing at another angler's row reads back
  -- as no lure rather than putting their tackle box in this angler's patterns.
  LEFT JOIN lures l ON l.id = ca.lure_id AND l.user_id = ca.user_id
  WHERE ca.user_id = ? AND ca.deleted_at IS NULL AND t.deleted_at IS NULL
  ORDER BY ca.caught_at DESC
  LIMIT ?`

export interface AnglerHistory {
  hours: ExposureHour[]
  catches: CatchEvent[]
}

export async function loadHistory(
  db: D1Database,
  userId: string,
  limit: number = MAX_HOURS_PER_USER,
): Promise<AnglerHistory> {
  const [hours, catches] = await Promise.all([
    db.prepare(HOURS_SQL).bind(userId, limit).all<ExposureHour>(),
    // A catch needs an hour to be counted, so there is no point loading more catches than the
    // hours could possibly hold. Ten per hour is a very good day, every hour, for years.
    db.prepare(CATCHES_SQL).bind(userId, limit * 10).all<CatchEvent>(),
  ])
  return { hours: hours.results, catches: catches.results }
}

/** Anglers whose patterns are due: never computed, or last completed before the cutoff. */
export async function usersDueForRecompute(
  db: D1Database,
  before: number,
  limit: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id
       FROM users u
       LEFT JOIN pattern_runs r ON r.user_id = u.id
       WHERE u.deleted_at IS NULL AND (r.completed_at IS NULL OR r.completed_at < ?)
       ORDER BY COALESCE(r.completed_at, 0), u.id
       LIMIT ?`,
    )
    .bind(before, limit)
    .all<{ id: string }>()
  return results.map((row) => row.id)
}
