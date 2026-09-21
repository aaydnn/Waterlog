import {
  aggregate,
  bucketStats,
  dispersion,
  hoursToResolve,
  leaveBestTripOut,
  type Aggregate,
  type CountFn,
  type StatsContext,
} from './analyze';
import type { EngineConfig } from './config';
import {
  CONTEXT_DIMENSIONS,
  CURATED_COMBOS,
  comboDimension,
  dimensionsForScope,
  bucketOf,
  getSingle,
  type DimensionDef,
} from './dimensions';
import { bucketPhrase, findingSummary } from './explain';
import { benjaminiHochberg, quantile } from './stats/distributions';
import { kaplanMeier, kmMedian, survivalAt } from './stats/km';
import type {
  BlindSpot,
  BucketStats,
  Cell,
  Check,
  DimensionInsight,
  Family,
  Finding,
  Gap,
  OutcomeKey,
  ScopeId,
  Tier,
  WaterProfile,
} from './types';

export interface FamilyWork {
  family: Family;
  ctx: StatsContext;
  clock: Cell[];
  rod: Cell[];
  count: CountFn;
  aggs: Map<string, Aggregate>;
  /** Every computed bucket (surfaced or not) — hypotheses and briefings read from here. */
  allStats: Map<string, BucketStats>;
}

export const findingKey = (scopeId: ScopeId, outcome: OutcomeKey, dimension: string, bucket: string) =>
  `${scopeId}::${outcome}::${dimension}::${bucket}`;

const TIER_RANK: Record<Tier, number> = { early: 1, promising: 2, solid: 3 };

export function analyzeFamily(
  scopeId: ScopeId,
  outcome: OutcomeKey,
  clock: Cell[],
  rod: Cell[],
  count: CountFn,
  config: EngineConfig,
): FamilyWork {
  const phi = dispersion(clock, count, config.maxDispersion);
  const ctx: StatsContext = { phi, config, allowWaterStrata: scopeId === 'all' };
  const aggs = new Map<string, Aggregate>();
  const allStats = new Map<string, BucketStats>();
  const cellsFor = (d: DimensionDef) => (d.population === 'rod' ? rod : clock);

  const runDim = (d: DimensionDef) => {
    const agg = aggregate(cellsFor(d), d, count);
    aggs.set(d.key, agg);
    for (const bucket of [...agg.buckets.keys()].sort()) {
      const s = bucketStats(agg, bucket, ctx);
      if (s) allStats.set(`${d.key}::${bucket}`, s);
    }
  };

  // 1. Single dimensions.
  const singles = dimensionsForScope(scopeId);
  singles.forEach(runDim);

  // 2. Bounded combo search: curated interactions + pairs among the strongest singles (ideas 9, 10).
  const strong = [...allStats.values()]
    .filter((s) => baseGate(s, config) && effectPass(s, config))
    .sort((a, b) => Math.abs(b.logRR) - Math.abs(a.logRR) || a.dimension.localeCompare(b.dimension));
  const topDims = [...new Set(strong.map((s) => s.dimension))].slice(0, 4);
  const pairs: Array<readonly [string, string]> = [...CURATED_COMBOS];
  for (let i = 0; i < topDims.length; i++)
    for (let j = i + 1; j < topDims.length; j++) pairs.push([topDims[i]!, topDims[j]!]);
  const allowed = new Set(singles.map((d) => d.key));
  const combos = new Map<string, DimensionDef>();
  for (const [a, b] of pairs) {
    if (!allowed.has(a) || !allowed.has(b)) continue;
    const d = comboDimension(a, b);
    if (d && !combos.has(d.key) && combos.size < config.maxComboDimensions) combos.set(d.key, d);
  }
  [...combos.values()].forEach(runDim);

  // 3. False-discovery control across everything searched in this family.
  const tested = [...allStats.values()].filter((s) => s.testable && s.pValue !== null);
  const q = benjaminiHochberg(tested.map((s) => s.pValue!));
  tested.forEach((s, i) => (s.qValue = q[i]!));

  // 4. Tier, suppress, challenge.
  const offeringById = new Map(rod.flatMap((c) => (c.offering ? [[c.offering.id, c.offering] as const] : [])));
  const findings: Finding[] = [];
  for (const s of [...allStats.values()]) {
    let tier = evidenceTier(s, config);
    if (!tier) continue;
    const dim = s.dimension.includes('+') ? combos.get(s.dimension)! : getSingle(s.dimension)!;
    if (suppressedByParent(s, dim, allStats, offeringById, config)) continue;

    const checks: Check[] = [];
    const loo = leaveBestTripOut(aggs.get(s.dimension)!, s, ctx);
    const looPass = !!loo?.stats?.testable && Math.sign(loo.stats.logRR) === Math.sign(s.logRR) && Math.abs(loo.stats.logRR) >= 0.5 * Math.abs(s.logRR);
    checks.push({
      id: 'leave_best_trip_out',
      status: looPass ? 'passed' : 'failed',
      detail: looPass
        ? `Still ${loo!.stats!.multiplier.toFixed(1)}x without your most influential trip.`
        : 'Most of this result comes from a single trip.',
    });
    checks.push({
      id: 'exposure_quality',
      status: s.qualityScore >= config.qualitySolid ? 'passed' : 'failed',
      detail: `${Math.round((s.qualityHours.measured / Math.max(s.hours, 1e-9)) * 100)}% of the time behind this was measured.`,
    });
    checks.push({
      id: 'replicated_across_weeks',
      status: s.distinctWeeks >= config.solidMinWeeks ? 'passed' : 'failed',
      detail: `Seen across ${s.distinctWeeks} separate week${s.distinctWeeks === 1 ? '' : 's'}.`,
    });
    checks.push({
      id: 'search_corrected',
      status: s.qValue !== null && s.qValue <= config.qPromising ? 'passed' : 'failed',
      detail: `Checked against ${tested.length} comparisons searched in this set.`,
    });
    if (!looPass && tier === 'solid') tier = 'promising';

    findings.push({
      key: findingKey(scopeId, outcome, s.dimension, s.bucket),
      scopeId,
      outcome,
      kind: s.dimension.includes('+') ? 'combo' : 'single',
      direction: s.logRR >= 0 ? 'positive' : 'negative',
      tier,
      stats: s,
      checks,
      confounders: [],
      gap: null,
      hoursToResolve: hoursToResolve(s),
      testsInFamily: tested.length,
      aliases: [],
      lifecycle: 'hypothesis',
      summary: findingSummary(outcome, s),
    });
  }

  // 4b. Collapse aliases: identical evidence under different offering descriptors.
  const deduped = collapseAliases(findings);
  findings.length = 0;
  findings.push(...deduped);

  // 5. Competing explanations + untested conditions (ideas 24, 39, 40, 68).
  findings.sort(compareFindings);
  const contextDims = CONTEXT_DIMENSIONS.filter((k) => allowed.has(k)).map((k) => getSingle(k)!);
  findings.forEach((f, idx) => {
    const dim = f.kind === 'combo' ? combos.get(f.stats.dimension)! : getSingle(f.stats.dimension)!;
    const cells = cellsFor(dim);
    const candidates = contextDims.filter((d) => d.key !== dim.key && !dim.parents.includes(d.key));
    f.gap = findGap(cells, dim, f.stats.bucket, candidates);
    if (idx >= config.maxConfounderChecks || f.stats.rawLogRR === null) {
      f.checks.push({ id: 'survives_adjustment', status: 'not_yet', detail: 'Not yet checked for competing explanations.' });
      return;
    }
    for (const d of candidates) {
      const agg = aggregate(cells, dim, count, (c) => bucketOf(d, c) ?? '?');
      const adj = bucketStats(agg, f.stats.bucket, ctx);
      if (!adj?.testable || adj.rawLogRR === null) continue;
      const orig = f.stats.rawLogRR!;
      if (Math.sign(adj.rawLogRR) !== Math.sign(orig) || Math.abs(adj.rawLogRR) < 0.5 * Math.abs(orig)) {
        const sh = shares(cells, dim, f.stats.bucket, d);
        const dominant = [...sh.entries()].sort((a, b) => b[1].fin - a[1].fin || (a[0] < b[0] ? -1 : 1))[0];
        f.confounders.push({
          dimension: d.key,
          adjustedMultiplier: Math.exp(adj.logRR),
          dominantBucket: dominant?.[0] ?? '?',
          findingShare: dominant?.[1].fin ?? 0,
          populationShare: dominant?.[1].pop ?? 0,
        });
      }
    }
    const explained = f.confounders.length > 0;
    f.checks.push({
      id: 'survives_adjustment',
      status: explained ? 'failed' : 'passed',
      detail: explained
        ? `Overlaps with ${f.confounders.map((c) => bucketPhrase(c.dimension, c.dominantBucket)).join(', ')} — your history can't yet separate them.`
        : f.stats.strataLevel === 'none'
          ? 'Holds against other factors, but compared against all your fishing (no same-water/season baseline yet).'
          : 'Holds after accounting for water, season, and other conditions.',
    });
    if (explained) f.tier = 'early';
  });
  findings.sort(compareFindings);

  const family: Family = {
    scopeId,
    outcome,
    dispersion: phi,
    testsRun: tested.length,
    populationHours: clock.reduce((s, c) => s + c.hours, 0),
    populationTrips: new Set(clock.map((c) => c.trip.id)).size,
    findings,
    insights: littleDifference(scopeId, outcome, singles, allStats, findings, aggs, config),
    blindSpots: blindSpots(clock),
    profile: outcome === 'all' ? profile(scopeId, clock, count) : null,
  };
  return { family, ctx, clock, rod, count, aggs, allStats };
}

const OFFERING_PRIORITY: Record<string, number> = { offering_family: 0, offering_color: 1, offering: 2 };

function collapseAliases(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const dims = f.stats.dimension.split('+');
    const buckets = f.stats.bucket.split('|');
    const context = dims.map((d, i) => (d in OFFERING_PRIORITY ? '' : `${d}=${buckets[i]}`)).filter(Boolean).sort().join('&');
    if (context.length > 0 && dims.every((d) => !(d in OFFERING_PRIORITY))) {
      groups.set(f.key, [f]);
      continue;
    }
    const fp = `${context}#${f.stats.catches}#${f.stats.hours.toFixed(6)}#${f.stats.exposedTrips}`;
    groups.set(fp, [...(groups.get(fp) ?? []), f]);
  }
  const rank = (f: Finding) =>
    f.stats.dimension.split('+').reduce((s, d) => s + (OFFERING_PRIORITY[d] ?? 0), 0) * 10 + f.stats.dimension.split('+').length;
  const out: Finding[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : 1));
    const [keep, ...rest] = g;
    keep!.aliases = rest.map((r) => `${r.stats.dimension}::${r.stats.bucket}`);
    out.push(keep!);
  }
  return out;
}

export function compareFindings(a: Finding, b: Finding): number {
  return (
    TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
    Math.abs(b.stats.logRR) - Math.abs(a.stats.logRR) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

export function baseGate(s: BucketStats, c: EngineConfig): boolean {
  if (!s.testable || s.hours < c.minBucketHours || s.exposedTrips < c.minExposedTrips) return false;
  if (s.logRR >= 0) return s.catches >= c.minCatches;
  return s.catches >= c.minCatches || s.expected >= c.minExpectedForNegative;
}

export const effectPass = (s: BucketStats, c: EngineConfig) => Math.abs(s.logRR) >= Math.log(c.minEffect);

export function credible(s: BucketStats, c: EngineConfig): boolean {
  if (s.logRR >= 0) return s.ci95[0] > 1;
  return s.ci95[1] < 1 || (s.catches < c.minCatches && s.upperBound95 < 1);
}

export function evidenceTier(s: BucketStats, c: EngineConfig): Tier | null {
  if (!baseGate(s, c) || !effectPass(s, c)) return null;
  const q = s.qValue ?? 1;
  if (!(credible(s, c) && q <= c.qPromising && s.qualityScore >= c.qualityPromising)) return 'early';
  if (q <= c.qSolid && s.exposedTrips >= c.solidMinExposedTrips && s.distinctWeeks >= c.solidMinWeeks && s.qualityScore >= c.qualitySolid)
    return 'solid';
  return 'promising';
}

function suppressedByParent(
  s: BucketStats,
  dim: DimensionDef,
  all: Map<string, BucketStats>,
  offeringById: Map<string, { family: string | null; color: string | null }>,
  c: EngineConfig,
): boolean {
  if (dim.parents.length === 0) return false;
  let parentBuckets: Array<[string, string | null]>;
  if (dim.key === 'offering') {
    const o = offeringById.get(s.bucket);
    parentBuckets = [['offering_family', o?.family ?? null], ['offering_color', o?.color ?? null]];
  } else {
    const parts = s.bucket.split('|');
    parentBuckets = dim.parents.map((p, i) => [p, parts[i] ?? null]);
  }
  let strongest = 0;
  for (const [pd, pb] of parentBuckets) {
    if (pb === null) continue;
    const ps = all.get(`${pd}::${pb}`);
    if (ps?.testable && Math.sign(ps.logRR) === Math.sign(s.logRR)) strongest = Math.max(strongest, Math.abs(ps.logRR));
  }
  return Math.abs(s.logRR) < strongest + Math.log(c.comboMustBeatParentBy);
}

function shares(cells: ReadonlyArray<Cell>, dim: DimensionDef, bucket: string, d: DimensionDef) {
  const m = new Map<string, { pop: number; fin: number }>();
  let pop = 0;
  let fin = 0;
  for (const c of cells) {
    const db = bucketOf(d, c);
    if (db === null) continue;
    const e = m.get(db) ?? { pop: 0, fin: 0 };
    e.pop += c.hours;
    pop += c.hours;
    if (bucketOf(dim, c) === bucket) {
      e.fin += c.hours;
      fin += c.hours;
    }
    m.set(db, e);
  }
  for (const e of m.values()) {
    e.pop = pop > 0 ? e.pop / pop : 0;
    e.fin = fin > 0 ? e.fin / fin : 0;
  }
  return m;
}

/** The most common condition this finding has never really been tried in. */
export function findGap(cells: ReadonlyArray<Cell>, dim: DimensionDef, bucket: string, candidates: DimensionDef[]): Gap | null {
  let best: Gap | null = null;
  for (const d of candidates) {
    for (const [db, sh] of [...shares(cells, dim, bucket, d).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (sh.pop >= 0.15 && sh.fin < 0.05 && (!best || sh.pop > best.populationShare))
        best = { dimension: d.key, bucket: db, populationShare: sh.pop, findingShare: sh.fin };
    }
  }
  return best;
}

function littleDifference(
  scopeId: ScopeId,
  outcome: OutcomeKey,
  singles: DimensionDef[],
  all: Map<string, BucketStats>,
  findings: Finding[],
  aggs: Map<string, Aggregate>,
  c: EngineConfig,
): DimensionInsight[] {
  const out: DimensionInsight[] = [];
  for (const d of singles) {
    if (findings.some((f) => f.stats.dimension === d.key && f.tier !== 'early')) continue;
    const agg = aggs.get(d.key)!;
    const eq = [...all.values()].filter(
      (s) =>
        s.dimension === d.key &&
        s.testable &&
        s.hours >= 2 * c.minBucketHours &&
        s.exposedTrips >= 4 &&
        s.ci95[0] >= 1 / c.equivalenceMargin &&
        s.ci95[1] <= c.equivalenceMargin,
    );
    const covered = eq.reduce((t, s) => t + s.hours, 0);
    if (eq.length >= 2 && agg.knownHours > 0 && covered / agg.knownHours >= 0.7) {
      const buckets = eq.map((s) => s.bucket).sort();
      out.push({
        scopeId,
        outcome,
        dimension: d.key,
        kind: 'little_difference',
        buckets,
        summary: `Choosing between ${buckets.map((b) => bucketPhrase(d.key, b)).join(', ')} hasn't made a meaningful difference for you.`,
      });
    }
  }
  return out;
}

const EXPECTED_BUCKETS: Record<string, string[]> = {
  time_block: ['dawn', 'morning', 'midday', 'evening', 'dusk'],
  season: ['spring', 'summer', 'fall', 'winter'],
};

function blindSpots(clock: ReadonlyArray<Cell>): BlindSpot[] {
  const total = clock.reduce((s, c) => s + c.hours, 0);
  if (total < 20) return [];
  const out: BlindSpot[] = [];
  for (const [key, buckets] of Object.entries(EXPECTED_BUCKETS)) {
    const d = getSingle(key)!;
    const h = new Map<string, number>();
    let known = 0;
    for (const c of clock) {
      const b = bucketOf(d, c);
      if (b === null) continue;
      h.set(b, (h.get(b) ?? 0) + c.hours);
      known += c.hours;
    }
    if (known < 20) continue;
    for (const b of buckets) {
      const share = (h.get(b) ?? 0) / known;
      if (share < 0.05) out.push({ dimension: key, bucket: b, share });
    }
  }
  return out;
}

/** Time to first fish (Kaplan–Meier, skunks censored), skunk odds, and upside. Ideas 57–59. */
export function profile(scopeId: ScopeId, clock: ReadonlyArray<Cell>, count: CountFn): WaterProfile | null {
  const byTrip = new Map<string, Cell[]>();
  for (const c of clock) {
    const l = byTrip.get(c.trip.id);
    if (l) l.push(c);
    else byTrip.set(c.trip.id, [c]);
  }
  if (byTrip.size === 0) return null;
  const obs: Array<{ t: number; event: boolean }> = [];
  const rates: number[] = [];
  let hours = 0;
  let catches = 0;
  let skunks = 0;
  for (const cells of byTrip.values()) {
    cells.sort((a, b) => a.start - b.start);
    let minutes = 0;
    let first: number | null = null;
    let tc = 0;
    let th = 0;
    for (const c of cells) {
      const k = count(c);
      if (first === null && k > 0) {
        const firstAt = Math.min(...c.catches.map((x) => x.caughtAt));
        first = minutes + Math.min(c.hours * 60, Math.max(0, (firstAt - c.start) / 60_000));
      }
      minutes += c.hours * 60;
      tc += k;
      th += c.hours;
    }
    obs.push(first === null ? { t: minutes, event: false } : { t: first, event: true });
    if (tc === 0) skunks++;
    if (th >= 0.25) rates.push(tc / th);
    hours += th;
    catches += tc;
  }
  const curve = kaplanMeier(obs);
  const maxT = Math.max(...obs.map((o) => o.t));
  return {
    scopeId,
    trips: byTrip.size,
    fishableHours: hours,
    catchRate: hours > 0 ? catches / hours : 0,
    skunkRate: skunks / byTrip.size,
    medianMinutesToFirstFish: kmMedian(curve),
    pNoFishBy60: maxT >= 60 ? survivalAt(curve, 60) : null,
    pNoFishBy120: maxT >= 120 ? survivalAt(curve, 120) : null,
    p90TripRate: quantile(rates, 0.9) ?? 0,
  };
}
