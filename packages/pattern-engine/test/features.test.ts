import { describe, expect, it } from 'vitest';
import { buildBriefing, runEngine, summarizeTrip } from '../src';
import { verdictFor } from '../src/hypotheses';
import { DEFAULT_CONFIG } from '../src/config';
import type { BucketStats, ConditionFeatures, HypothesisInput } from '../src/types';
import { DAY, generate, HOUR } from './fixtures';

const effect = ({ offering, features }: { offering: { family: string | null }; features: ConditionFeatures }) =>
  offering.family === 'spinnerbait' && features.pressureTrend === 'falling' ? 3.5 : 1;
const hyps: HypothesisInput[] = [
  { id: 'h1', dimension: 'offering_family+pressure_trend', bucket: 'spinnerbait|falling', scopeId: 'all', outcome: 'all', expectation: 'better', createdAt: 0 },
  { id: 'h2', dimension: 'moon', bucket: 'full', scopeId: 'all', outcome: 'all', expectation: 'better', createdAt: 0 },
  { id: 'h3', dimension: 'offering_color', bucket: 'chartreuse', scopeId: 'w1', outcome: 'all', expectation: 'worse', createdAt: 0 },
  { id: 'h4', dimension: 'sky', bucket: 'overcast', scopeId: 'nowhere', outcome: 'all', expectation: 'better', createdAt: 0 },
  { id: 'h5', dimension: 'rain_prev_48h+wind', bucket: 'dry|calm', scopeId: 'all', outcome: 'all', expectation: 'no_difference', createdAt: 0 },
  { id: 'h6', dimension: 'offering_family+moon', bucket: 'jig|full', scopeId: 'all', outcome: 'all', expectation: 'better', createdAt: 0 },
];
const input = { ...generate({ seed: 7, trips: 80, effect }), hypotheses: hyps };
const res = runEngine(input);

describe('hypothesis notebook', () => {
  it('tests stated beliefs against history, including on-demand combos', () => {
    const v = Object.fromEntries(res.hypotheses.map((h) => [h.id, h]));
    expect(v.h1!.verdict).toBe('supported');
    expect(v.h3!.verdict).toBe('contradicted');
    expect(v.h4!.verdict).toBe('insufficient');
    expect(v.h4!.stats).toBeNull();
    expect(['unresolved', 'contradicted', 'insufficient']).toContain(v.h2!.verdict);
    expect(v.h5!.stats).not.toBeNull();
    expect(v.h6!.stats).not.toBeNull();
    expect(v.h1!.falsifier).toContain('at or below');
    expect(v.h3!.falsifier).toContain('at or above');
    expect(v.h5!.falsifier).toContain('clearly above or below');
  });

  it('verdict logic', () => {
    const s = (lo: number, hi: number) => ({ testable: true, hours: 10, exposedTrips: 5, ci95: [lo, hi] }) as BucketStats;
    const c = DEFAULT_CONFIG;
    expect(verdictFor('better', null, c)).toBe('insufficient');
    expect(verdictFor('better', s(1.2, 2), c)).toBe('supported');
    expect(verdictFor('better', s(0.4, 0.9), c)).toBe('contradicted');
    expect(verdictFor('better', s(0.9, 1.1), c)).toBe('contradicted');
    expect(verdictFor('better', s(0.6, 1.9), c)).toBe('unresolved');
    expect(verdictFor('worse', s(0.4, 0.9), c)).toBe('supported');
    expect(verdictFor('no_difference', s(0.9, 1.1), c)).toBe('supported');
    expect(verdictFor('no_difference', s(1.1, 1.9), c)).toBe('contradicted');
    expect(verdictFor('no_difference', s(0.6, 1.9), c)).toBe('unresolved');
  });

  it('suggests at most three experiments, ranked by value', () => {
    expect(res.experiments.length).toBeLessThanOrEqual(3);
    expect(res.experiments.length).toBeGreaterThan(0);
    for (let i = 1; i < res.experiments.length; i++) expect(res.experiments[i - 1]!.value).toBeGreaterThanOrEqual(res.experiments[i]!.value);
    const noisy = runEngine({
      ...generate({ seed: 31, trips: 50 }),
      hypotheses: [{ id: 'hx', dimension: 'pressure_trend', bucket: 'falling', scopeId: 'all', outcome: 'all', expectation: 'better', createdAt: 0 }],
    });
    const h = noisy.hypotheses[0]!;
    if (h.verdict === 'unresolved' && h.hoursToResolve !== null) expect(noisy.experiments.some((e) => e.kind === 'resolve_hypothesis')).toBe(true);
  });
});

describe('pre-trip briefing', () => {
  const start = input.now + DAY;
  const forecast = Array.from({ length: 6 }, (_, i) => ({
    start: start + (6 + i) * HOUR,
    end: start + (7 + i) * HOUR,
    features: { pressureTrend: 'falling', cloudPct: 80, windKph: 12, waterTempC: 18, minutesFromSunrise: (i - 0.5) * 60, minutesToSunset: (13 - i) * 60, season: 'summer' } as ConditionFeatures,
  }));

  it('ranks what to throw from matching personal evidence, with both-sided analogs', () => {
    const b = buildBriefing({ history: input, result: res, waterBodyId: 'w1', forecast, availableMinutes: 120 });
    expect(b.scopeUsed).toBe('w1');
    expect(b.fellBackToAllWaters).toBe(false);
    expect(b.throw[0]!.bucket).toBe('spinnerbait');
    expect(b.throw[0]!.group).toBe(1);
    expect(b.bestWindow!.end - b.bestWindow!.start).toBe(2 * HOUR);
    expect(b.productiveAnalogs.length).toBe(3);
    expect(b.unproductiveAnalogs.length).toBe(2);
    expect(b.productiveAnalogs.every((a) => a.catches > 0)).toBe(true);
    expect(['medium', 'high']).toContain(b.confidence);
    expect(b.outOfExperience).toEqual([]);
  });

  it('warns when conditions are outside the angler’s experience and falls back to all waters', () => {
    const hot = forecast.map((f) => ({ ...f, features: { ...f.features, waterTempC: 40, season: 'winter' as const } }));
    const b = buildBriefing({ history: { ...input, trips: input.trips }, result: res, waterBodyId: 'w9', forecast: hot });
    expect(b.fellBackToAllWaters).toBe(true);
    expect(b.confidence).toBe('low');
    expect(b.outOfExperience.map((o) => o.feature)).toContain('waterTempC');
    expect(b.bestWindow).toBeNull();
    const winterless = buildBriefing({ history: { ...input, conditions: input.conditions.map((c) => ({ ...c, features: { ...c.features, season: 'summer' as const } })) }, result: res, waterBodyId: null, forecast: hot });
    expect(winterless.outOfExperience.map((o) => o.feature)).toContain('season');
  });
});

describe('post-trip lesson', () => {
  it('reports what a trip strengthened, weakened, and cannot speak to', () => {
    const lesson = summarizeTrip(input, res, 't079');
    expect(lesson.tripId).toBe('t079');
    expect(lesson.hours).toBeGreaterThan(0);
    expect(lesson.measuredOfferingShare).toBe(1);
    const all = [...lesson.strengthened, ...lesson.weakened];
    expect(all.every((x) => x.expected >= 0.5)).toBe(true);
    const saw = { str: 0, weak: 0, little: 0 };
    for (const t of input.trips) {
      const l = summarizeTrip(input, res, t.id);
      saw.str += l.strengthened.length;
      saw.weak += l.weakened.length;
      saw.little += l.saysLittleAbout.length;
    }
    expect(saw.str).toBeGreaterThan(0);
    expect(saw.weak).toBeGreaterThan(0);
    expect(saw.little).toBeGreaterThan(0);
    expect(summarizeTrip(input, res, 'missing').hours).toBe(0);
  });
});
