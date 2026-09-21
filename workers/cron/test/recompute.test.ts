import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { ROW_BUDGET, recomputeUser } from '../src/lib/recompute'
import { loadHistory, usersDueForRecompute } from '../src/lib/load'
import { seedAngler, waterIdFor, type AnglerSeed } from './seed'

const NOW = Date.UTC(2026, 8, 15, 8)

/** The shape the fixtures lean on: trips that reliably produce a falling-pressure pattern. */
function hotFallingPressure(water: string | null): AnglerSeed['trips'] {
  return Array.from({ length: 6 }, () => ({
    water,
    hours: 4,
    conditions: { pressure_trend: 'stable' as const },
    hourOverrides: { 0: { pressure_trend: 'falling' as const } },
    catches: [{ hour: 0, color: 'chartreuse' }, { hour: 0, color: 'chartreuse' }, { hour: 1, color: 'white' }],
  }))
}

async function cachedScopes(userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT scope FROM pattern_cache WHERE user_id = ? ORDER BY scope',
  )
    .bind(userId)
    .all<{ scope: string }>()
  return results.map((r) => r.scope)
}

describe('loading an angler out of D1', () => {
  it('gives the engine one row per enriched trip-hour, with its water', async () => {
    const userId = await seedAngler({ email: 'load@example.com', trips: hotFallingPressure('lake1') })
    const history = await loadHistory(env.DB, userId)
    expect(history.hours).toHaveLength(24)
    expect(history.hours.every((h) => h.water_body_id === waterIdFor(userId, 'lake1'))).toBe(true)
    expect(history.catches).toHaveLength(18)
    expect(history.catches.filter((c) => c.lure_color === 'chartreuse')).toHaveLength(12)
  })

  it('leaves an open trip out of the hours entirely', async () => {
    const userId = await seedAngler({
      email: 'open-trip@example.com',
      trips: [...hotFallingPressure(null), { hours: 4, open: true, conditions: {}, catches: [{ hour: 0 }] }],
    })
    const history = await loadHistory(env.DB, userId)
    // An open trip has no ended_at, so it generated no hour buckets and cannot be a denominator.
    expect(history.hours).toHaveLength(24)
    // Its catch is still loaded, and comes back in unattributed_catches rather than vanishing.
    expect(history.catches).toHaveLength(19)
  })

  it('never reads another angler\'s rows', async () => {
    const mine = await seedAngler({ email: 'mine@example.com', trips: hotFallingPressure(null) })
    await seedAngler({ email: 'theirs@example.com', trips: hotFallingPressure(null) })
    const history = await loadHistory(env.DB, mine)
    expect(history.hours).toHaveLength(24)
  })

  it('respects the row ceiling rather than loading an unbounded history', async () => {
    const userId = await seedAngler({ email: 'capped@example.com', trips: hotFallingPressure(null) })
    const history = await loadHistory(env.DB, userId, 5)
    expect(history.hours).toHaveLength(5)
  })
})

describe('recomputing one angler', () => {
  it('writes a feed and records the run', async () => {
    const userId = await seedAngler({ email: 'recompute@example.com', trips: hotFallingPressure('lake1') })
    const outcome = await recomputeUser(env.DB, userId, null, NOW)

    expect(outcome.completed).toBe(true)
    expect(outcome.cursor).toBeNull()
    expect(outcome.patternCount).toBeGreaterThan(0)
    expect(await cachedScopes(userId)).toEqual(['all', waterIdFor(userId, 'lake1')])

    const run = await env.DB.prepare('SELECT * FROM pattern_runs WHERE user_id = ?')
      .bind(userId)
      .first<{ completed_at: number; cursor: string | null; pattern_count: number }>()
    expect(run).toMatchObject({ completed_at: NOW, cursor: null })
    expect(run!.pattern_count).toBe(outcome.patternCount)
  })

  it('reconciles with the rows it was given: catches and hours match raw SQL', async () => {
    const userId = await seedAngler({ email: 'reconcile@example.com', trips: hotFallingPressure(null) })
    await recomputeUser(env.DB, userId, null, NOW)

    const falling = await env.DB.prepare(
      "SELECT catches, hours, rate, baseline_rate, multiplier FROM pattern_cache WHERE user_id = ? AND scope = 'all' AND dimension = 'pressure_trend' AND bucket = 'falling'",
    )
      .bind(userId)
      .first<{ catches: number; hours: number; rate: number; baseline_rate: number; multiplier: number }>()

    // Six trips of four hours: one falling hour each with two fish, three stable with one.
    const raw = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM conditions WHERE user_id = ? AND trip_id IS NOT NULL AND pressure_trend = 'falling') AS falling_hours,
              (SELECT COUNT(*) FROM conditions WHERE user_id = ? AND trip_id IS NOT NULL) AS total_hours,
              (SELECT COUNT(*) FROM catches WHERE user_id = ?) AS total_catches`,
    )
      .bind(userId, userId, userId)
      .first<{ falling_hours: number; total_hours: number; total_catches: number }>()

    expect(falling!.hours).toBe(raw!.falling_hours)
    expect(falling!.catches).toBe(12)
    expect(falling!.baseline_rate).toBeCloseTo(raw!.total_catches / raw!.total_hours, 10)
    expect(falling!.multiplier).toBeCloseTo(falling!.rate / falling!.baseline_rate, 10)
  })

  it('persists the distinct-trip count, which is what the tiers are built on', async () => {
    const userId = await seedAngler({ email: 'trip-count@example.com', trips: hotFallingPressure(null) })
    await recomputeUser(env.DB, userId, null, NOW)

    const falling = await env.DB.prepare(
      "SELECT trips, confidence FROM pattern_cache WHERE user_id = ? AND dimension = 'pressure_trend' AND bucket = 'falling'",
    )
      .bind(userId)
      .first<{ trips: number; confidence: string }>()

    // Six separate outings, not one lucky evening — and the row has to say so, because the card's
    // footer reads it back and the tier is meaningless without it.
    expect(falling!.trips).toBe(6)
    expect(falling!.confidence).toBe('promising')
  })

  it('replaces a scope rather than appending to it, so a rerun is not a doubling', async () => {
    const userId = await seedAngler({ email: 'rerun@example.com', trips: hotFallingPressure('lake1') })
    const first = await recomputeUser(env.DB, userId, null, NOW)
    const second = await recomputeUser(env.DB, userId, null, NOW + 86_400_000)
    expect(second.patternCount).toBe(first.patternCount)
  })

  it('drops cached rows for a water that no longer produces patterns', async () => {
    const userId = await seedAngler({ email: 'stale-scope@example.com', trips: hotFallingPressure('lake1') })
    await recomputeUser(env.DB, userId, null, NOW)
    // A water the angler has not fished since, left over from an earlier run.
    await env.DB.prepare(
      `INSERT INTO pattern_cache (id, user_id, scope, dimension, bucket, catches, hours, rate, baseline_rate, multiplier, confidence, computed_at)
       VALUES ('stale1', ?, 'gone_lake', 'wind', 'calm', 9, 9, 1, 0.5, 2, 'promising', ?)`,
    )
      .bind(userId, NOW)
      .run()

    await recomputeUser(env.DB, userId, null, NOW + 86_400_000)
    expect(await cachedScopes(userId)).toEqual(['all', waterIdFor(userId, 'lake1')])
  })

  it('computes nothing for an angler under the ten-hour baseline, and says so by writing nothing', async () => {
    const userId = await seedAngler({
      email: 'thin@example.com',
      trips: [{ hours: 4, conditions: { pressure_trend: 'falling' }, catches: [{ hour: 0 }, { hour: 1 }, { hour: 2 }] }],
    })
    const outcome = await recomputeUser(env.DB, userId, null, NOW)
    expect(outcome.completed).toBe(true)
    expect(outcome.patternCount).toBe(0)
  })

  it('counts a catch its trip could not place, rather than losing it', async () => {
    const userId = await seedAngler({
      email: 'unattributed@example.com',
      trips: [...hotFallingPressure(null), { hours: 4, open: true, conditions: {}, catches: [{ hour: 0 }, { hour: 1 }] }],
    })
    const outcome = await recomputeUser(env.DB, userId, null, NOW)
    expect(outcome.unattributedCatches).toBe(2)

    const run = await env.DB.prepare('SELECT unattributed_catches FROM pattern_runs WHERE user_id = ?')
      .bind(userId)
      .first<{ unattributed_catches: number }>()
    expect(run!.unattributed_catches).toBe(2)
  })
})

describe('the CPU budget', () => {
  /** Four waters, so there are five scopes to work through including `all`. */
  function fourWaters(): AnglerSeed['trips'] {
    return ['lake1', 'lake2', 'lake3', 'lake4'].flatMap((water) => hotFallingPressure(water))
  }

  /** Scope ids are per-angler, so the comparison is on the numbers and their order, not on two
   * anglers happening to share a water id. */
  function feedOf(userId: string) {
    return env.DB.prepare(
      'SELECT dimension, bucket, catches, hours, multiplier, confidence FROM pattern_cache WHERE user_id = ? ORDER BY scope, dimension, bucket',
    )
      .bind(userId)
      .all()
  }

  // The real budget is in rows; a small one here cuts after the first scope instead of after
  // thousands, which is the same code path at a size a test can seed.
  const TINY_BUDGET = 1

  it('stops when the budget is spent and hands back where to resume', async () => {
    const userId = await seedAngler({ email: 'budget@example.com', trips: fourWaters() })
    const outcome = await recomputeUser(env.DB, userId, null, NOW, { rowBudget: TINY_BUDGET })

    expect(outcome.completed).toBe(false)
    expect(outcome.scopes).toEqual(['all'])
    expect(outcome.cursor).toBe(waterIdFor(userId, 'lake1'))

    const run = await env.DB.prepare('SELECT completed_at, cursor FROM pattern_runs WHERE user_id = ?')
      .bind(userId)
      .first<{ completed_at: number | null; cursor: string | null }>()
    // Not complete, so nothing claims it is: tonight's sweep will still pick this angler up.
    expect(run!.completed_at).toBeNull()
    expect(run!.cursor).toBe(waterIdFor(userId, 'lake1'))
  })

  it('a resumed run reaches the same feed an uninterrupted one would', async () => {
    const trips = fourWaters()
    const chunked = await seedAngler({ email: 'chunked@example.com', trips })
    let cursor: string | null = null
    let messages = 0
    do {
      const outcome = await recomputeUser(env.DB, chunked, cursor, NOW, { rowBudget: TINY_BUDGET })
      cursor = outcome.cursor
      messages += 1
      expect(messages).toBeLessThan(20)
    } while (cursor !== null)
    expect(messages).toBe(5) // one message per scope

    const straight = await seedAngler({ email: 'straight@example.com', trips })
    await recomputeUser(env.DB, straight, null, NOW)

    const chunkedFeed = await feedOf(chunked)
    const straightFeed = await feedOf(straight)
    expect(chunkedFeed.results).toEqual(straightFeed.results)
    expect(chunkedFeed.results.length).toBeGreaterThan(0)
  })

  it('finishes an ordinary angler in one message under the real budget', async () => {
    const userId = await seedAngler({ email: 'one-message@example.com', trips: fourWaters() })
    const outcome = await recomputeUser(env.DB, userId, null, NOW)
    expect(outcome.completed).toBe(true)
    expect(ROW_BUDGET).toBeGreaterThan(96)
  })

  it('restarts the angler when the cursor names a scope that no longer exists', async () => {
    const userId = await seedAngler({ email: 'lost-cursor@example.com', trips: hotFallingPressure('lake1') })
    const outcome = await recomputeUser(env.DB, userId, 'a_water_that_went_away', NOW)
    expect(outcome.completed).toBe(true)
    expect(await cachedScopes(userId)).toEqual(['all', waterIdFor(userId, 'lake1')])
  })
})

describe('the nightly sweep', () => {
  it('picks up an angler who has never been computed', async () => {
    const userId = await seedAngler({ email: 'never-run@example.com', trips: [] })
    expect(await usersDueForRecompute(env.DB, NOW, 1000)).toContain(userId)
  })

  it('skips one computed since the cutoff and keeps one computed before it', async () => {
    const fresh = await seedAngler({ email: 'fresh@example.com', trips: [] })
    const stale = await seedAngler({ email: 'stale@example.com', trips: [] })
    await env.DB.prepare(
      'INSERT INTO pattern_runs (user_id, completed_at, updated_at) VALUES (?, ?, ?), (?, ?, ?)',
    )
      .bind(fresh, NOW, NOW, stale, NOW - 5 * 86_400_000, NOW)
      .run()

    const due = await usersDueForRecompute(env.DB, NOW - 86_400_000, 1000)
    expect(due).not.toContain(fresh)
    expect(due).toContain(stale)
  })
})
