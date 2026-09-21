import { env } from 'cloudflare:test'
import { computePatterns, type Pattern } from '@waterlog/patterns'
import { runEngine } from '@waterlog/pattern-engine'
import { describe, expect, it } from 'vitest'
import { loadHistory } from '../src/lib/load'
import { loadEngineInput } from '../src/lib/v2/load'
import { compareEngines, formatParityReport } from '../src/lib/v2/parity'
import worker from '../src/index'
import { seedAngler, type AnglerSeed } from './seed'

/**
 * The parity gate (brief §7) run end to end: both engines, the same D1, the same history.
 *
 * These assert the properties ADR-0017 predicted rather than exact numbers, because exact numbers
 * are the engine's business and would make this a change-detector. What must hold is the shape of
 * the disagreement: v2's multipliers are smaller, v2 surfaces less on thin data, and nothing
 * disappears without the harness either explaining it or flagging it for review.
 */

const NOW = Date.UTC(2026, 8, 15, 8)

async function bothEngines(userId: string) {
  const v1 = computePatterns(await loadHistory(env.DB, userId))
  const v2 = runEngine(await loadEngineInput(env.DB, userId, NOW))
  return { v1, v2, report: compareEngines(v1.patterns, v2) }
}

function strongTrips(count: number): AnglerSeed['trips'] {
  return Array.from({ length: count }, () => ({
    hours: 4,
    conditions: { pressure_trend: 'stable' as const, season: 'summer' },
    hourOverrides: { 0: { pressure_trend: 'falling' as const } },
    catches: [
      { hour: 0, color: 'chartreuse' },
      { hour: 0, color: 'chartreuse' },
      { hour: 1, color: 'white' },
    ],
  }))
}

describe('the parity gate', () => {
  it('lines both engines up over one history and accounts for every card', async () => {
    const userId = await seedAngler({ email: 'parity-main@example.com', trips: strongTrips(12) })
    const { v1, report } = await bothEngines(userId)

    // Printed rather than only asserted: this table is the artefact the gate is reviewed from.
    console.log('\n' + formatParityReport(report))

    expect(v1.patterns.length).toBeGreaterThan(0)
    expect(report.rows.length).toBeGreaterThan(0)
    // Every v1 card is represented somewhere in the report — the harness cannot silently lose one.
    const v1Represented = report.rows.filter((r) => r.status === 'both' || r.status === 'v1_only')
    expect(v1Represented).toHaveLength(v1.patterns.length)
  })

  it('shrinks the positive finding and never flips a direction', async () => {
    const userId = await seedAngler({ email: 'parity-shrink@example.com', trips: strongTrips(12) })
    const { report } = await bothEngines(userId)

    const shared = report.rows.filter((r) => r.status === 'both')
    expect(shared.length).toBeGreaterThan(0)

    // The headline case ADR-0017 describes: a strong positive comes back smaller, because the
    // estimate is shrunk toward 1 and the seasonal tailwind is gone from the comparison.
    const falling = shared.find((r) => r.dimension === 'pressure_trend' && r.bucket === 'falling')
    expect(falling).toBeDefined()
    expect(falling!.v2!.multiplier).toBeLessThan(falling!.v1!.multiplier)
    expect(falling!.v2!.multiplier).toBeGreaterThan(1)

    // Deliberately NOT asserting that every shared row moves toward 1. The negative side can move
    // the other way, and does here: v1 divides by the angler's season-wide rate, while v2 compares
    // against the alternatives available in the same water and season — which on this fixture are
    // the hot falling hours. Being measured against a better alternative makes a poor bucket look
    // worse, and that is the estimator working, not shrinkage failing.
    for (const row of shared) {
      // What must hold in every case: shrinkage moves magnitude, never direction. A card that
      // flipped from "better" to "worse" between engines would be a bug.
      expect(Math.sign(Math.log(row.v1!.multiplier))).toBe(Math.sign(Math.log(row.v2!.multiplier)))
    }
  })

  it('matches v1 lure dimensions to v2 offering dimensions instead of double-counting them', async () => {
    // The engines named the same thing differently — lure_color vs offering_color — and an
    // unmapped comparison reports one vanished card and one new card for every lure pattern. On a
    // real log those would be the loudest rows in the gate and all of them wrong.
    //
    // The v1 side is written by hand rather than seeded, so the test turns on the mapping instead
    // of on whether v1's thresholds happen to surface a lure card for a given fixture.
    const userId = await seedAngler({ email: 'parity-lure-names@example.com', trips: strongTrips(12) })
    const { v2 } = await bothEngines(userId)

    const v2Colour = v2.families
      .filter((f) => f.outcome === 'all')
      .flatMap((f) => f.findings)
      .find((f) => f.stats.dimension === 'offering_color' && f.stats.bucket === 'chartreuse')
    expect(v2Colour).toBeDefined()

    const v1Patterns: Pattern[] = [
      {
        scope: 'all',
        dimension: 'lure_color',
        bucket: 'chartreuse',
        catches: 24,
        hours: 24,
        rate: 1,
        baseline_rate: 0.75,
        multiplier: 1.33,
        confidence: 'promising',
        trips: 12,
      },
    ]

    const report = compareEngines(v1Patterns, v2)
    const row = report.rows.find((r) => r.dimension === 'offering_color' && r.bucket === 'chartreuse')

    expect(row).toBeDefined()
    expect(row!.status).toBe('both')
    expect(report.summary.v1Only).toBe(0)
    // And nothing anywhere in the report keeps v1's spelling.
    expect(report.rows.every((r) => !r.dimension.startsWith('lure_'))).toBe(true)
  })

  it('maps both halves of a combo dimension', async () => {
    const userId = await seedAngler({ email: 'parity-combo-names@example.com', trips: strongTrips(12) })
    const { v2 } = await bothEngines(userId)

    const combo = v2.families
      .filter((f) => f.outcome === 'all')
      .flatMap((f) => f.findings)
      .find((f) => f.stats.dimension === 'offering_color+pressure_trend')
    expect(combo).toBeDefined()

    const v1Patterns: Pattern[] = [
      {
        scope: 'all',
        dimension: 'lure_color+pressure_trend',
        bucket: combo!.stats.bucket,
        catches: 12,
        hours: 6,
        rate: 2,
        baseline_rate: 0.75,
        multiplier: 2.67,
        confidence: 'promising',
        trips: 12,
      },
    ]

    const report = compareEngines(v1Patterns, v2)
    const row = report.rows.find((r) => r.dimension === 'offering_color+pressure_trend')
    expect(row!.status).toBe('both')
  })

  it('flags a v1 card that v2 dropped, rather than quietly losing it', async () => {
    // Thin, noisy history: v1's count-based tiers will surface things v2's credibility tiers will
    // not, which is the disagreement the gate exists to adjudicate.
    const userId = await seedAngler({
      email: 'parity-thin@example.com',
      trips: [
        { hours: 4, conditions: { pressure_trend: 'falling', season: 'summer' }, catches: [{ hour: 0 }, { hour: 1 }] },
        { hours: 4, conditions: { pressure_trend: 'falling', season: 'summer' }, catches: [{ hour: 0 }] },
        { hours: 4, conditions: { pressure_trend: 'stable', season: 'summer' }, catches: [{ hour: 2 }] },
        { hours: 4, conditions: { pressure_trend: 'stable', season: 'summer' }, catches: [] },
      ],
    })
    const { v1, report } = await bothEngines(userId)
    console.log('\nTHIN HISTORY\n' + formatParityReport(report))

    // Whatever v1 produced, the report accounts for all of it.
    const accounted = report.rows.filter((r) => r.status === 'both' || r.status === 'v1_only')
    expect(accounted).toHaveLength(v1.patterns.length)

    // Anything v1 had and v2 dropped is either explained by v2 or queued for review — never
    // dropped silently.
    for (const row of report.rows.filter((r) => r.status === 'v1_only')) {
      expect(row.note).not.toBe('')
    }
  })

  it('serves the comparison only when the route is opted into', async () => {
    const userId = await seedAngler({ email: 'parity-route@example.com', trips: strongTrips(12) })
    const url = `http://cron.test/__parity?user=${userId}`

    // Deployed, the flag is absent and the route is indistinguishable from an unknown path. This
    // reads one angler's whole history, so it must not be reachable on a production worker.
    const off = await worker.fetch(new Request(url), env)
    expect(off.status).toBe(404)

    const on = { ...env, ALLOW_PARITY_ROUTE: 'true' }
    const res = await worker.fetch(new Request(url), on)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('pressure_trend')
    expect(body).toContain('in both')

    // Even opted in, it is the only path this worker answers.
    const other = await worker.fetch(new Request('http://cron.test/'), on)
    expect(other.status).toBe(404)
    const noUser = await worker.fetch(new Request('http://cron.test/__parity'), on)
    expect(noUser.status).toBe(400)
  })

  it('reports an angler both engines say nothing about as an empty, clean comparison', async () => {
    const userId = await seedAngler({
      email: 'parity-empty@example.com',
      trips: [{ hours: 2, conditions: { pressure_trend: 'falling' }, catches: [{ hour: 0 }] }],
    })
    const { v1, report } = await bothEngines(userId)

    expect(v1.patterns).toHaveLength(0)
    expect(report.rows).toHaveLength(0)
    expect(report.summary.unexplained).toBe(0)
  })

  it('does not count v2 species families as disagreements with v1', async () => {
    const userId = await seedAngler({ email: 'parity-families@example.com', trips: strongTrips(12) })
    const { v2, report } = await bothEngines(userId)

    // v2 really did compute a species family here, or the exclusion proves nothing.
    expect(v2.families.some((f) => f.outcome !== 'all')).toBe(true)
    // v1 never computed per-species patterns, so a species finding is not a card v1 lost. Counting
    // them would bury the real disagreements under noise.
    const dupes = report.rows.filter((r) => r.status === 'v2_only' && r.note.includes('species'))
    expect(dupes).toHaveLength(0)
  })
})
