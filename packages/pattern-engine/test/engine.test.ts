import { describe, expect, it } from 'vitest';
import { runEngine, toPersisted } from '../src';
import { aggregate, bucketStats, dispersion, hoursToResolve, leaveBestTripOut } from '../src/analyze';
import { DEFAULT_CONFIG } from '../src/config';
import { getSingle } from '../src/dimensions';
import { buildExposure } from '../src/exposure';
import { analyzeFamily, evidenceTier } from '../src/family';
import type { EngineInput, EngineResult, Finding } from '../src/types';
import { DAY, generate, HOUR, merge, shuffled } from './fixtures';

const spinFalling = (m: number) => ({ offering, features }: { offering: { family: string | null }; features: { pressureTrend?: string | null } }) =>
  offering.family === 'spinnerbait' && features.pressureTrend === 'falling' ? m : 1;
const KEY = 'all::all::offering_family+pressure_trend::spinnerbait|falling';
const allFindings = (r: EngineResult): Finding[] => r.families.flatMap((f) => f.findings);
const fam = (r: EngineResult, scope = 'all', outcome = 'all') => r.families.find((f) => f.scopeId === scope && f.outcome === outcome)!;

describe('discovery', () => {
  const input = generate({ seed: 7, trips: 80, effect: spinFalling(3.5) });
  const res = runEngine(input);

  it('finds a planted interaction as solid, with an evidence receipt', () => {
    const f = fam(res).findings.find((x) => x.key === KEY)!;
    expect(f).toBeDefined();
    expect(f.tier).toBe('solid');
    expect(f.direction).toBe('positive');
    expect(f.stats.multiplier).toBeGreaterThan(2);
    expect(f.stats.ci95[0]).toBeGreaterThan(1);
    expect(f.stats.trips.length).toBe(f.stats.exposedTrips);
    expect(f.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['leave_best_trip_out', 'exposure_quality', 'replicated_across_weeks', 'search_corrected', 'survives_adjustment', 'prospective']),
    );
    expect(f.summary).toContain('Spinnerbaits + falling pressure');
    expect(f.testsInFamily).toBe(fam(res).testsRun);
  });

  it('collapses aliased descriptors (only chartreuse lure is the only spinnerbait)', () => {
    const f = fam(res).findings.find((x) => x.key === KEY)!;
    expect(f.aliases).toEqual(expect.arrayContaining(['offering_color+pressure_trend::chartreuse|falling']));
    expect(fam(res).findings.some((x) => x.stats.dimension === 'offering_color+pressure_trend' && x.stats.bucket === 'chartreuse|falling')).toBe(false);
  });

  it('analyzes per-water scopes and species/bigger-fish outcomes', () => {
    expect(res.families.map((f) => `${f.scopeId}/${f.outcome}`)).toEqual(
      expect.arrayContaining(['all/all', 'w1/all', 'w2/all', 'all/species:largemouth_bass', 'all/quality']),
    );
    expect(fam(res, 'w1').findings.every((f) => f.stats.dimension !== 'water_body')).toBe(true);
    expect(fam(res).profile!.trips).toBe(80);
    expect(fam(res, 'all', 'quality').profile).toBeNull();
  });

  it('is deterministic: input order never changes output', () => {
    const shuffledInput: EngineInput = {
      ...input,
      trips: shuffled(input.trips, 1),
      conditions: shuffled(input.conditions, 2),
      catches: shuffled(input.catches, 3),
      offeringSessions: shuffled(input.offeringSessions, 4),
      offerings: shuffled(input.offerings, 5),
    };
    expect(JSON.stringify(runEngine(shuffledInput))).toBe(JSON.stringify(res));
  });

  it('persists compact receipts', () => {
    const p = toPersisted(res, 2);
    for (const f of allFindings(p)) expect(f.stats.trips.length).toBeLessThanOrEqual(4);
    const neg = allFindings(res).find((f) => f.direction === 'negative' && f.stats.trips.length > 4);
    if (neg) expect(toPersisted(res, 2).families.flatMap((x) => x.findings).find((f) => f.key === neg.key)!.stats.trips.length).toBe(4);
  });
});

describe('false-discovery defense', () => {
  it('produces no solid findings on pure noise, and very few promising', () => {
    let solid = 0;
    let promising = 0;
    for (let s = 0; s < 12; s++) {
      const r = runEngine(generate({ seed: 500 + s, trips: 80 }));
      for (const f of allFindings(r)) {
        if (f.tier === 'solid') solid++;
        if (f.tier === 'promising') promising++;
      }
    }
    expect(solid).toBe(0);
    expect(promising).toBeLessThanOrEqual(6);
  });

  it('reports "little difference" when evidence shows a choice does not matter', () => {
    const r = runEngine(generate({ seed: 11, trips: 300 }));
    const insight = fam(r).insights.find((i) => i.dimension === 'season');
    expect(insight?.kind).toBe('little_difference');
    expect(insight!.buckets.length).toBeGreaterThanOrEqual(2);
    expect(insight!.summary).toContain("hasn't made a meaningful difference");
  });
});

describe('negative and zero-catch evidence', () => {
  it('surfaces a lure fished for hours without a single fish', () => {
    const r = runEngine(generate({ seed: 3, trips: 60, effect: ({ offering }) => (offering.id === 'worm' ? 0 : 1) }));
    const f = fam(r).findings.find((x) => x.stats.dimension === 'offering_family' && x.stats.bucket === 'soft_plastic')!;
    expect(f.direction).toBe('negative');
    expect(f.stats.catches).toBe(0);
    expect(f.tier).not.toBe('early');
    expect(f.stats.upperBound95).toBeLessThan(1);
    expect(f.summary).toMatch(/^No fish in/);
  });
});

describe('competing explanations', () => {
  it('flags sky as confounded with wind when overcast days are the windy ones', () => {
    const input = generate({
      seed: 5,
      trips: 120,
      tripFeatures: (r) => {
        const windy = r() < 0.5;
        return { windKph: windy ? 25 : 4, cloudPct: windy ? (r() < 0.85 ? 90 : 10) : r() < 0.85 ? 10 : 90 };
      },
      effect: ({ features }) => ((features.windKph ?? 0) > 20 ? 2.5 : 1),
    });
    const r = runEngine(input);
    const overcast = fam(r).findings.find((x) => x.stats.dimension === 'sky' && x.stats.bucket === 'overcast')!;
    expect(overcast.tier).toBe('early');
    expect(overcast.confounders.map((c) => c.dimension)).toContain('wind');
    expect(overcast.checks.find((c) => c.id === 'survives_adjustment')!.status).toBe('failed');
    const windy = fam(r).findings.find((x) => x.stats.dimension === 'wind' && x.stats.bucket === 'strong')!;
    expect(windy.tier).toBe('solid');
    expect(windy.confounders).toEqual([]);
  });
});

describe('robustness checks', () => {
  it('leave-best-trip-out collapses a one-trip wonder', () => {
    const input = generate({ seed: 4, trips: 40 });
    const hero = input.trips[10]!;
    const extra = Array.from({ length: 25 }, (_, i) => ({
      id: `hero-${i}`,
      tripId: hero.id,
      caughtAt: hero.startedAt + 10 * 60_000 + i * 1000,
      offeringId: input.offeringSessions.find((s) => s.tripId === hero.id)!.offeringId,
      species: 'largemouth_bass',
      lengthMm: 300,
    }));
    const boosted = { ...input, catches: [...input.catches, ...extra] };
    const ex = buildExposure(boosted, DEFAULT_CONFIG);
    const dim = getSingle('offering')!;
    const count = (c: { catches: unknown[] }) => c.catches.length;
    const ctx = { phi: 1, config: DEFAULT_CONFIG, allowWaterStrata: true };
    const agg = aggregate(ex.rod, dim, count);
    const stats = bucketStats(agg, extra[0]!.offeringId, ctx)!;
    const loo = leaveBestTripOut(agg, stats, ctx)!;
    expect(loo.tripId).toBe(hero.id);
    expect(loo.stats!.logRR).toBeLessThan(stats.logRR / 2);
    expect(leaveBestTripOut(agg, { ...stats, trips: stats.trips.slice(0, 1) }, ctx)).toBeNull();
    expect(dispersion(ex.clock, count, 8)).toBeGreaterThan(1);
  });

  it('tiers respect gates, quality, and weeks', () => {
    const w = analyzeFamily('all', 'all', ...(() => {
      const ex = buildExposure(generate({ seed: 7, trips: 80, effect: spinFalling(3.5) }), DEFAULT_CONFIG);
      return [ex.clock, ex.rod] as const;
    })(), (c) => c.catches.length, DEFAULT_CONFIG);
    const s = w.allStats.get('offering_family+pressure_trend::spinnerbait|falling')!;
    expect(evidenceTier(s, DEFAULT_CONFIG)).toBe('solid');
    expect(evidenceTier({ ...s, qualityScore: 0.6 }, DEFAULT_CONFIG)).toBe('promising');
    expect(evidenceTier({ ...s, qualityScore: 0.3 }, DEFAULT_CONFIG)).toBe('early');
    expect(evidenceTier({ ...s, exposedTrips: 2 }, DEFAULT_CONFIG)).toBeNull();
    expect(evidenceTier({ ...s, testable: false }, DEFAULT_CONFIG)).toBeNull();
    expect(evidenceTier({ ...s, logRR: 0.1 }, DEFAULT_CONFIG)).toBeNull();
    expect(hoursToResolve(s)).toBe(0);
    expect(hoursToResolve({ ...s, rawLogRR: null })).toBeNull();
    expect(hoursToResolve({ ...s, rawLogRR: 0 })).toBeNull();
    expect(hoursToResolve({ ...s, rawLogRR: 0.3, varLogRR: 0.05 })).toBeGreaterThan(0);
    expect(hoursToResolve({ ...s, rawLogRR: 0.01, varLogRR: 5 })).toBeNull();
  });
});

describe('target species', () => {
  it('excludes trips aimed at another species from species exposure', () => {
    const input = generate({ seed: 21, trips: 60 });
    const trips = input.trips.map((t, i) => ({ ...t, targetSpecies: i % 3 === 0 ? 'crappie' : i % 3 === 1 ? 'mixed' : null }));
    const r = runEngine({ ...input, trips });
    const bass = fam(r, 'all', 'species:largemouth_bass');
    expect(bass.populationTrips).toBe(40);
    expect(fam(r).populationTrips).toBe(60);
  });
});

describe('lifecycle', () => {
  const a = generate({ seed: 7, trips: 80, effect: spinFalling(3.5) });
  const r1 = runEngine(a);
  const b = merge(a, generate({ seed: 8, trips: 40, startOffsetDays: 400, effect: spinFalling(3.5), idPrefix: 'b' }));
  const r2 = runEngine({ ...b, previousRecords: r1.records });
  const rec = (r: EngineResult) => r.records.find((x) => x.key === KEY)!;

  it('discovers, then confirms on later independent trips', () => {
    expect(rec(r1).state).toBe('repeated');
    expect(rec(r1).history[0]!.reasons).toEqual(['discovered']);
    expect(rec(r2).state).toBe('confirmed');
    expect(rec(r2).history.at(-1)!.reasons).toEqual(expect.arrayContaining(['new_trips:40', 'prospective_passed']));
    expect(fam(r2).findings.find((f) => f.key === KEY)!.lifecycle).toBe('confirmed');
  });

  it('weakens when the pattern stops working, retires, and can revive', () => {
    const c = merge(b, generate({ seed: 9, trips: 120, startOffsetDays: 620, effect: spinFalling(0.3), idPrefix: 'c' }));
    const r3 = runEngine({ ...c, previousRecords: r2.records });
    expect(rec(r3).state).toBe('weakening');
    const r3b = runEngine({ ...c, now: c.now + 10 * DAY, previousRecords: r3.records });
    expect(rec(r3b).state).toBe('weakening');
    const r4 = runEngine({ ...c, now: c.now + 70 * DAY, previousRecords: r3.records });
    expect(rec(r4).state).toBe('retired');
    const r4b = runEngine({ ...c, now: c.now + 80 * DAY, previousRecords: r4.records });
    expect(rec(r4b).state).toBe('retired');
    const d = merge(c, generate({ seed: 10, trips: 150, startOffsetDays: 1250, effect: spinFalling(4), idPrefix: 'd' }));
    const r5 = runEngine({ ...d, previousRecords: r4.records });
    expect(['repeated', 'emerging']).toContain(rec(r5).state);
    expect(rec(r5).history.at(-1)!.reasons).toContain('revived');
  });

  it('explains edited history even without a state change', () => {
    const edited = { ...b, trips: b.trips.filter((t) => t.id !== 't005') };
    const r = runEngine({ ...edited, previousRecords: r2.records });
    expect(rec(r).history.at(-1)!.reasons).toContain('earlier_logs_edited');
  });

  it('handles engine upgrades, reversals, and carries unevaluated records', () => {
    const old = r1.records.map((x) => ({ ...x, engineVersion: '1.0.0' }));
    const ghost = { ...rec(r1), key: 'zz-water::all::sky::clear' };
    const reversed = old.map((x) => (x.key === KEY ? { ...x, direction: 'negative' as const } : x));
    const r = runEngine({ ...a, previousRecords: [...reversed, ghost] });
    expect(rec(r).state).toBe('hypothesis');
    expect(rec(r).history.at(-1)!.reasons).toEqual(expect.arrayContaining(['engine_updated', 'direction_reversed']));
    expect(r.records.find((x) => x.key === ghost.key)).toEqual(ghost);
  });
});

describe('thin data', () => {
  it('returns no families below the minimum history and never throws on empty input', () => {
    const empty = runEngine({ userId: 'u', now: 0, trips: [], conditions: [], catches: [], offerings: [], offeringSessions: [] });
    expect(empty.families).toEqual([]);
    expect(empty.experiments).toEqual([]);
    const tiny = runEngine(generate({ seed: 1, trips: 2 }));
    expect(tiny.families).toEqual([]);
  });

  it('an early finding that softens from emerging becomes weakening', () => {
    const input = generate({ seed: 7, trips: 80, effect: spinFalling(3.5) });
    const r1 = runEngine(input);
    const target = fam(r1).findings.find((f) => f.tier === 'early')!;
    const prev = r1.records.map((x) => (x.key === target.key ? { ...x, state: 'emerging' as const } : x));
    const r2 = runEngine({ ...input, previousRecords: prev });
    expect(r2.records.find((x) => x.key === target.key)!.state).toBe('weakening');
  });
});

void HOUR;
