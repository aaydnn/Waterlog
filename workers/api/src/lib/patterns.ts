import { MIN_BASELINE_HOURS } from '@waterlog/patterns'
import type { PatternCard, PatternFeed, PatternTeaser } from '@waterlog/schema'

/**
 * Reading the pattern feed (F6).
 *
 * Everything here is a read of `pattern_cache`, which the cron worker wrote overnight. Nothing is
 * computed on the request path: the feed is the retention moment and it opens instantly, which is
 * the whole reason the cache exists (packet §07).
 *
 * The free tier is redacted **here**, on the server. See ADR-0016: a full card sent to the browser
 * and blurred in CSS is not a paywall, it is a rendering choice one devtools tab away from being
 * the product.
 */

/** Cards a feed returns at most. Sorted by |multiplier|, so the strongest findings are the ones
 * that survive the cut — an angler with ninety patterns is not helped by all ninety. */
const MAX_CARDS = 60

const CARD_SELECT = `
  SELECT p.id, p.scope, w.name AS scope_name, p.dimension, p.bucket, p.catches, p.hours, p.rate,
         p.baseline_rate, p.multiplier, p.confidence, p.trips, p.computed_at
  FROM pattern_cache p
  -- Owner-scoped, like every other join in this codebase: a scope that names a water this angler
  -- does not own reads back with no name rather than borrowing someone else's.
  LEFT JOIN water_bodies w ON w.id = p.scope AND w.user_id = p.user_id
  WHERE p.user_id = ?`

/** How a dimension is described to someone who has not paid to see the bucket. True, and useless
 * on its own, which is exactly the intent. */
const DIMENSION_LABELS: Record<string, string> = {
  lure_family: 'the kind of lure you throw',
  lure_color: 'your lure colour',
  pressure_trend: 'barometric pressure',
  sky: 'cloud cover',
  wind: 'wind',
  water_temp: 'water temperature',
  moon: 'the moon',
  time_block: 'time of day',
  season: 'the season',
}

export function dimensionLabel(dimension: string): string {
  const parts = dimension.split('+')
  const labelled = parts.map((part) => DIMENSION_LABELS[part] ?? part.replace(/_/g, ' '))
  return labelled.length > 1 ? `${labelled[0]} and ${labelled[1]}` : labelled[0]!
}

async function readCards(db: D1Database, userId: string, scope: string | null): Promise<PatternCard[]> {
  const where = scope === null ? '' : ' AND p.scope = ?'
  const binds: unknown[] = scope === null ? [userId] : [userId, scope]
  const { results } = await db
    .prepare(`${CARD_SELECT}${where} ORDER BY ABS(p.multiplier - 1) DESC, p.dimension, p.bucket LIMIT ?`)
    .bind(...binds, MAX_CARDS)
    .all<PatternCard>()
  return results
}

/**
 * Hours this angler still needs before any rate can be computed, or 0 once the engine has a
 * baseline. Feeds the progress meter packet §09 asks for in place of an empty screen.
 */
async function hoursUntilBaseline(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS hours FROM conditions
       WHERE user_id = ? AND trip_id IS NOT NULL AND hour_bucket IS NOT NULL`,
    )
    .bind(userId)
    .first<{ hours: number }>()
  return Math.max(0, MIN_BASELINE_HOURS - (row?.hours ?? 0))
}

async function lastComputedAt(db: D1Database, userId: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT completed_at FROM pattern_runs WHERE user_id = ?')
    .bind(userId)
    .first<{ completed_at: number | null }>()
  return row?.completed_at ?? null
}

async function countPatterns(db: D1Database, userId: string, scope: string | null): Promise<number> {
  const where = scope === null ? '' : ' AND scope = ?'
  const binds: unknown[] = scope === null ? [userId] : [userId, scope]
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?${where}`)
    .bind(...binds)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export interface FeedQuery {
  /** Restrict to one water, or null for the all-waters view plus every per-water card. */
  scope: string | null
}

export async function getPatternFeed(
  db: D1Database,
  userId: string,
  tier: string,
  query: FeedQuery,
): Promise<PatternFeed> {
  const [cards, hours_until_baseline, computed_at] = await Promise.all([
    readCards(db, userId, query.scope),
    hoursUntilBaseline(db, userId),
    lastComputedAt(db, userId),
  ])

  if (tier === 'pro') {
    const unattributed = await db
      .prepare('SELECT unattributed_catches AS n FROM pattern_runs WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    return {
      tier: 'pro',
      patterns: cards,
      unattributed_catches: unattributed?.n ?? 0,
      hours_until_baseline,
      computed_at,
    }
  }

  // Free: the true count, and per card only enough to say a pattern of that kind exists. No
  // bucket, no multiplier, no counts — none of it crosses the wire.
  //
  // The count is counted, not taken from the page: the page stops at MAX_CARDS and "3 patterns
  // found in your fishing" has to be the number that is actually there.
  const teasers: PatternTeaser[] = cards.map((card) => ({
    id: card.id,
    dimension_label: dimensionLabel(card.dimension),
    confidence: card.confidence,
  }))
  return {
    tier: 'free',
    total: await countPatterns(db, userId, query.scope),
    teasers,
    hours_until_baseline,
    computed_at,
  }
}
