import { aggregate, bucketStats, hoursToResolve } from './analyze';
import type { EngineConfig } from './config';
import { canonicalize, CONTEXT_DIMENSIONS, dimensionsForScope, getSingle, resolveDimension } from './dimensions';
import { bucketPhrase } from './explain';
import { findGap, type FamilyWork } from './family';
import { statsOnSubset } from './lifecycle';
import type { BucketStats, Experiment, HypothesisInput, HypothesisResult, Ms } from './types';

const DAY = 86_400_000;

export function verdictFor(
  expectation: HypothesisInput['expectation'],
  s: BucketStats | null,
  c: EngineConfig,
): HypothesisResult['verdict'] {
  if (!s || !s.testable || s.hours < c.minBucketHours || s.exposedTrips < c.minExposedTrips) return 'insufficient';
  const [lo, hi] = s.ci95;
  const m = c.equivalenceMargin;
  const equivalent = lo >= 1 / m && hi <= m;
  if (expectation === 'no_difference') return equivalent ? 'supported' : lo > 1 || hi < 1 ? 'contradicted' : 'unresolved';
  const supports = expectation === 'better' ? lo > 1 : hi < 1;
  const opposes = expectation === 'better' ? hi < 1 : lo > 1;
  if (supports) return 'supported';
  if (opposes || equivalent) return 'contradicted';
  return 'unresolved';
}

export function evaluateHypotheses(
  hypotheses: ReadonlyArray<HypothesisInput>,
  works: ReadonlyArray<FamilyWork>,
  config: EngineConfig,
): HypothesisResult[] {
  return hypotheses
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((raw) => {
      const h = { ...raw, ...canonicalize(raw.dimension, raw.bucket) };
      const work = works.find((w) => w.family.scopeId === h.scopeId && w.family.outcome === h.outcome);
      const dim = resolveDimension(h.dimension);
      const falsifier =
        h.expectation === 'no_difference'
          ? `Weakens if comparable future trips show ${bucketPhrase(h.dimension, h.bucket)} clearly above or below your normal rate.`
          : `Weakens if comparable future trips with ${bucketPhrase(h.dimension, h.bucket)} come in ${h.expectation === 'better' ? 'at or below' : 'at or above'} your normal rate.`;
      if (!work || !dim) {
        return { id: h.id, verdict: 'insufficient', sinceCreated: 'insufficient', stats: null, prospectiveStats: null, hoursToResolve: null, gap: null, falsifier };
      }
      let stats = work.allStats.get(`${dim.key}::${h.bucket}`) ?? null;
      if (!stats && !work.aggs.has(dim.key)) {
        const cells = dim.population === 'rod' ? work.rod : work.clock;
        stats = bucketStats(aggregate(cells, dim, work.count), h.bucket, work.ctx);
      }
      const prospectiveStats = statsOnSubset(work, dim.key, h.bucket, (c) => c.trip.startedAt > h.createdAt);
      const allowed = new Set(dimensionsForScope(h.scopeId).map((d) => d.key));
      const candidates = CONTEXT_DIMENSIONS.filter((k) => allowed.has(k) && k !== dim.key && !dim.parents.includes(k)).map((k) => getSingle(k)!);
      return {
        id: h.id,
        verdict: verdictFor(h.expectation, stats, config),
        sinceCreated: verdictFor(h.expectation, prospectiveStats, config),
        stats,
        prospectiveStats,
        hoursToResolve: stats ? hoursToResolve(stats) : null,
        gap: findGap(dim.population === 'rod' ? work.rod : work.clock, dim, h.bucket, candidates),
        falsifier,
      };
    });
}

/** Rank small, feasible tests by learning value (ideas 40, 47, 68). */
export function suggestExperiments(
  works: ReadonlyArray<FamilyWork>,
  hypotheses: ReadonlyArray<HypothesisResult>,
  hypothesisInputs: ReadonlyArray<HypothesisInput>,
  now: Ms,
  limit = 3,
): Experiment[] {
  const recent = new Set(works.flatMap((w) => w.clock.filter((c) => c.trip.startedAt >= now - 180 * DAY).map((c) => c.trip.id)));
  const scopeWeight = (w: FamilyWork) => {
    if (w.family.scopeId === 'all' || recent.size === 0) return 1;
    const inScope = new Set(w.clock.filter((c) => recent.has(c.trip.id)).map((c) => c.trip.id));
    return inScope.size / recent.size;
  };
  const out: Experiment[] = [];

  for (const w of works) {
    const weight = scopeWeight(w);
    for (const f of w.family.findings) {
      if (f.outcome !== 'all') continue;
      const phrase = bucketPhrase(f.stats.dimension, f.stats.bucket);
      if (f.tier !== 'solid' && f.hoursToResolve !== null && f.hoursToResolve > 0) {
        out.push({
          kind: 'resolve_finding',
          ref: f.key,
          scopeId: f.scopeId,
          dimension: f.stats.dimension,
          bucket: f.stats.bucket,
          under: null,
          hoursToResolve: f.hoursToResolve,
          value: (Math.abs(f.stats.logRR) * weight) / Math.max(1, f.hoursToResolve),
          summary: `About ${f.hoursToResolve} more hours with ${phrase} would tell us whether this is real.`,
        });
      }
      if (f.tier !== 'early' && f.gap) {
        out.push({
          kind: 'test_transfer',
          ref: f.key,
          scopeId: f.scopeId,
          dimension: f.stats.dimension,
          bucket: f.stats.bucket,
          under: { dimension: f.gap.dimension, bucket: f.gap.bucket },
          hoursToResolve: null,
          value: 0.5 * Math.abs(f.stats.logRR) * f.gap.populationShare * weight,
          summary: `You've barely tried ${phrase} with ${bucketPhrase(f.gap.dimension, f.gap.bucket)}, even though that's ${Math.round(f.gap.populationShare * 100)}% of your fishing. One session would show whether it carries over.`,
        });
      }
    }
    if (w.family.outcome === 'all') {
      for (const b of w.family.blindSpots) {
        out.push({
          kind: 'fill_blind_spot',
          ref: `${w.family.scopeId}::${b.dimension}::${b.bucket}`,
          scopeId: w.family.scopeId,
          dimension: b.dimension,
          bucket: b.bucket,
          under: null,
          hoursToResolve: null,
          value: 0.05 * weight,
          summary: `You have almost no ${bucketPhrase(b.dimension, b.bucket)} history here, so conclusions about timing are incomplete.`,
        });
      }
    }
  }
  for (const h of hypotheses) {
    const input = hypothesisInputs.find((x) => x.id === h.id);
    if (!input || h.verdict !== 'unresolved' || h.hoursToResolve === null || !h.stats) continue;
    out.push({
      kind: 'resolve_hypothesis',
      ref: h.id,
      scopeId: input.scopeId,
      dimension: input.dimension,
      bucket: input.bucket,
      under: h.gap ? { dimension: h.gap.dimension, bucket: h.gap.bucket } : null,
      hoursToResolve: h.hoursToResolve,
      // User-stated beliefs get a boost: the angler told us this question matters.
      value: (1.5 * Math.max(Math.abs(h.stats.logRR), 0.1)) / Math.max(1, h.hoursToResolve),
      summary: `About ${h.hoursToResolve} more hours with ${bucketPhrase(input.dimension, input.bucket)} would settle your belief one way or the other.`,
    });
  }
  return out.sort((a, b) => b.value - a.value || (a.ref < b.ref ? -1 : 1)).slice(0, limit);
}
