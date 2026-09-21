import type { EngineConfig } from './config';
import { QUALITY_SCORE } from './config';
import { bucketOf, type DimensionDef } from './dimensions';
import { binomTail, poissonUpper, twoSidedP } from './stats/distributions';
import { normalQuantile } from './stats/special';
import type { BucketStats, Cell, Quality, TripContribution, TripMeta } from './types';

export type StrataLevel = BucketStats['strataLevel'];
export type CountFn = (cell: Cell) => number;

const SEP = '\u0001';
const Z95 = normalQuantile(0.975);

interface NT { n: number; T: number }
interface AT { a: number; t1: number }

interface TripStratum {
  trip: TripMeta;
  s: string;
  a: number;
  t1: number;
}

interface BucketAgg {
  bucket: string;
  strata: Map<string, AT>;
  /** Keyed by tripId + SEP2 + stratum. Flat to keep allocation (and GC) low. */
  tripStrata: Map<string, TripStratum>;
  quality: Record<Quality, number>;
}

export interface Aggregate {
  dim: DimensionDef;
  /** Stratum key = water + SEP + season (finest); coarser levels are derived. */
  strata: Map<string, NT>;
  buckets: Map<string, BucketAgg>;
  knownHours: number;
  totalHours: number;
  cells: ReadonlyArray<Cell>;
  count: CountFn;
  extra: ((c: Cell) => string) | undefined;
}

const SEP2 = '\u0002';
const STRATUM_MEMO = '\u0000stratum';

function stratumOf(c: Cell): string {
  const memo = (c.memo ??= {});
  const hit = memo[STRATUM_MEMO];
  if (typeof hit === 'string') return hit;
  const s = `${c.trip.waterBodyId ?? '?'}${SEP}${c.features.season ?? '?'}`;
  memo[STRATUM_MEMO] = s;
  return s;
}

export function aggregate(
  cells: ReadonlyArray<Cell>,
  dim: DimensionDef,
  count: CountFn,
  /** Extra stratification (competing-explanation adjustment, idea 24). */
  extra?: (c: Cell) => string,
): Aggregate {
  const agg: Aggregate = { dim, strata: new Map(), buckets: new Map(), knownHours: 0, totalHours: 0, cells, count, extra };
  for (const c of cells) {
    agg.totalHours += c.hours;
    const b = bucketOf(dim, c);
    if (b === null) continue;
    agg.knownHours += c.hours;
    const s = extra ? `${stratumOf(c)}#${extra(c)}` : stratumOf(c);
    const k = count(c);
    let st = agg.strata.get(s);
    if (!st) agg.strata.set(s, (st = { n: 0, T: 0 }));
    st.n += k;
    st.T += c.hours;
    let ba = agg.buckets.get(b);
    if (!ba) {
      ba = { bucket: b, strata: new Map(), tripStrata: new Map(), quality: { measured: 0, estimated: 0, reconstructed: 0, apportioned: 0 } };
      agg.buckets.set(b, ba);
    }
    let bs = ba.strata.get(s);
    if (!bs) ba.strata.set(s, (bs = { a: 0, t1: 0 }));
    bs.a += k;
    bs.t1 += c.hours;
    const tk = c.trip.id + SEP2 + s;
    let ts = ba.tripStrata.get(tk);
    if (!ts) ba.tripStrata.set(tk, (ts = { trip: c.trip, s, a: 0, t1: 0 }));
    ts.a += k;
    ts.t1 += c.hours;
    ba.quality[c.quality] += c.hours;
  }
  return agg;
}

/** Extra adjustment strata (after '#') survive coarsening, so 'none' still adjusts for the confounder. */
function coarsen(s: string, level: StrataLevel): string {
  if (level === 'water_season') return s;
  if (level === 'season') return s.slice(s.indexOf(SEP) + 1);
  const i = s.indexOf('#');
  return i >= 0 ? s.slice(i) : '*';
}

export interface Row { a: number; t1: number; n: number; T: number }

function rows(agg: Aggregate, bucket: BucketAgg, level: StrataLevel): Row[] {
  const m = new Map<string, Row>();
  for (const [s, nt] of agg.strata) {
    const key = coarsen(s, level);
    let r = m.get(key);
    if (!r) m.set(key, (r = { a: 0, t1: 0, n: 0, T: 0 }));
    r.n += nt.n;
    r.T += nt.T;
    const at = bucket.strata.get(s);
    if (at) {
      r.a += at.a;
      r.t1 += at.t1;
    }
  }
  return [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([, r]) => r);
}

export interface MhResult {
  logRR: number;
  varLogRR: number;
  observed: number;
  expectedComp: number;
  informativeHours: number;
  pValue: number;
}

const EPS_H = 1e-9;

/** Mantel–Haenszel person-time rate ratio (bucket vs comparable alternatives in the same strata),
 *  Greenland–Robins variance, dispersion-inflated score test. */
export function mantelHaenszel(rs: ReadonlyArray<Row>, phi: number, minHours: number): MhResult | null {
  const inf = rs.filter((r) => r.t1 > EPS_H && r.T - r.t1 > EPS_H);
  const infHours = inf.reduce((s, r) => s + r.t1, 0);
  if (infHours < minHours) return null;
  let observed = 0;
  let expectedComp = 0;
  let en = 0;
  let v = 0;
  let N = 0;
  for (const r of inf) {
    const t0 = r.T - r.t1;
    observed += r.a;
    expectedComp += (r.t1 * (r.n - r.a)) / t0;
    const p = r.t1 / r.T;
    en += r.n * p;
    v += r.n * p * (1 - p);
    N += r.n;
  }
  const mhFor = (cc: number) => {
    let num = 0;
    let den = 0;
    let gr = 0;
    for (const r of inf) {
      const a = r.a + cc;
      const b = r.n - r.a + cc;
      const t0 = r.T - r.t1;
      num += (a * t0) / r.T;
      den += (b * r.t1) / r.T;
      gr += (r.t1 * t0 * (a + b)) / (r.T * r.T);
    }
    return { num, den, gr };
  };
  let m = mhFor(0);
  if (m.num <= 0 || m.den <= 0) m = mhFor(0.5);
  const logRR = Math.log(m.num / m.den);
  const varLogRR = (phi * m.gr) / (m.num * m.den);
  let pValue: number;
  if (v >= 5) {
    const z = Math.max(0, Math.abs(observed - en) - 0.5) / Math.sqrt(phi * v);
    pValue = twoSidedP(z);
  } else if (N === 0) {
    pValue = 1;
  } else {
    const pbar = en / N;
    pValue = Math.min(1, 2 * Math.min(binomTail(observed, N, pbar, 'le'), binomTail(observed, N, pbar, 'ge')));
  }
  return { logRR, varLogRR, observed, expectedComp, informativeHours: infHours, pValue };
}

export function shrink(logRR: number, v: number, priorSd: number): { mean: number; variance: number } {
  const t2 = priorSd * priorSd;
  const w = t2 / (t2 + v);
  return { mean: w * logRR, variance: w * v };
}

export interface StatsContext {
  phi: number;
  config: EngineConfig;
  allowWaterStrata: boolean;
}

function chooseLevel(agg: Aggregate, b: BucketAgg, ctx: StatsContext) {
  const levels: StrataLevel[] = ctx.allowWaterStrata ? ['water_season', 'season', 'none'] : ['season', 'none'];
  for (const level of levels) {
    const mh = mantelHaenszel(rows(agg, b, level), ctx.phi, ctx.config.minBucketHours);
    if (mh) return { level, mh };
  }
  return null;
}

export function bucketStats(agg: Aggregate, bucket: string, ctx: StatsContext): BucketStats | null {
  const b = agg.buckets.get(bucket);
  if (!b) return null;
  const { config, phi } = ctx;
  const chosen = chooseLevel(agg, b, ctx);
  const qTotal = Object.values(b.quality).reduce((s, h) => s + h, 0);
  const qualityScore =
    qTotal > 0 ? (Object.entries(b.quality) as [Quality, number][]).reduce((s, [q, h]) => s + QUALITY_SCORE[q] * h, 0) / qTotal : 0;

  // Complement rates at the chosen level, for per-trip expectations.
  const compRates = new Map<string, number>();
  if (chosen) {
    const byLevel = new Map<string, { b: number; t0: number }>();
    for (const [s, nt] of agg.strata) {
      const key = coarsen(s, chosen.level);
      let r = byLevel.get(key);
      if (!r) byLevel.set(key, (r = { b: 0, t0: 0 }));
      const at = b.strata.get(s);
      r.b += nt.n - (at?.a ?? 0);
      r.t0 += nt.T - (at?.t1 ?? 0);
    }
    for (const [k, r] of byLevel) compRates.set(k, r.t0 > EPS_H ? r.b / r.t0 : 0);
  }
  const perTrip = new Map<string, TripContribution & { week: number }>();
  for (const ts of b.tripStrata.values()) {
    let t = perTrip.get(ts.trip.id);
    if (!t) perTrip.set(ts.trip.id, (t = { tripId: ts.trip.id, startedAt: ts.trip.startedAt, catches: 0, hours: 0, expected: 0, week: ts.trip.week }));
    t.catches += ts.a;
    t.hours += ts.t1;
    if (chosen) t.expected += ts.t1 * (compRates.get(coarsen(ts.s, chosen.level)) ?? 0);
  }
  const sorted = [...perTrip.values()].sort((x, y) => x.startedAt - y.startedAt || (x.tripId < y.tripId ? -1 : 1));
  const contributions: TripContribution[] = sorted.map(({ week: _w, ...t }) => t);
  let catches = 0;
  let hours = 0;
  let expected = 0;
  let catchingTrips = 0;
  for (const t of contributions) {
    catches += t.catches;
    hours += t.hours;
    expected += t.expected;
    if (t.catches > 0) catchingTrips++;
  }

  const base = {
    dimension: agg.dim.key,
    bucket,
    catches,
    hours,
    expected,
    exposedTrips: contributions.length,
    catchingTrips,
    distinctWeeks: new Set(sorted.map((t) => t.week)).size,
    qualityScore,
    qualityHours: { ...b.quality },
    dimensionCoverage: agg.totalHours > 0 ? agg.knownHours / agg.totalHours : 0,
    trips: contributions,
  };

  if (!chosen) {
    return {
      ...base,
      rawLogRR: null,
      varLogRR: null,
      logRR: 0,
      postVar: config.priorSdLog ** 2,
      multiplier: 1,
      ci95: [Math.exp(-Z95 * config.priorSdLog), Math.exp(Z95 * config.priorSdLog)],
      pValue: null,
      qValue: null,
      upperBound95: Infinity,
      strataLevel: 'none',
      testable: false,
    };
  }
  const { mh, level } = chosen;
  const post = shrink(mh.logRR, mh.varLogRR, config.priorSdLog);
  const sd = Math.sqrt(post.variance);
  const effE = mh.expectedComp / phi;
  return {
    ...base,
    rawLogRR: mh.logRR,
    varLogRR: mh.varLogRR,
    logRR: post.mean,
    postVar: post.variance,
    multiplier: Math.exp(post.mean),
    ci95: [Math.exp(post.mean - Z95 * sd), Math.exp(post.mean + Z95 * sd)],
    pValue: mh.pValue,
    qValue: null,
    // Zero/low-catch evidence only matters for negatives; skip the root-find otherwise (perf).
    upperBound95: mh.logRR < 0 && effE > 0 ? poissonUpper(mh.observed / phi) / effE : Infinity,
    strataLevel: level,
    testable: true,
  };
}

/** Leave-the-most-influential-trip-out (idea 7). Re-aggregates without that trip. */
export function leaveBestTripOut(agg: Aggregate, stats: BucketStats, ctx: StatsContext): { tripId: string; stats: BucketStats | null } | null {
  if (stats.trips.length < 2) return null;
  const positive = stats.logRR >= 0;
  const best = stats.trips
    .slice()
    .sort((x, y) => {
      const dx = positive ? x.catches - x.expected : x.expected - x.catches;
      const dy = positive ? y.catches - y.expected : y.expected - y.catches;
      return dy - dx || (x.tripId < y.tripId ? -1 : 1);
    })[0]!;
  const without = aggregate(agg.cells.filter((c) => c.trip.id !== best.tripId), agg.dim, agg.count, agg.extra);
  return { tripId: best.tripId, stats: bucketStats(without, stats.bucket, ctx) };
}

/** Pearson dispersion across trips (idea 8: trips, not hours, are the replicates). */
export function dispersion(cells: ReadonlyArray<Cell>, count: CountFn, maxPhi: number): number {
  const strata = new Map<string, NT>();
  const trips = new Map<string, Array<{ s: string; h: number; k: number }>>();
  for (const c of cells) {
    const s = `${c.trip.waterBodyId ?? '?'}${SEP}${c.features.season ?? '?'}`;
    const k = count(c);
    let st = strata.get(s);
    if (!st) strata.set(s, (st = { n: 0, T: 0 }));
    st.n += k;
    st.T += c.hours;
    let list = trips.get(c.trip.id);
    if (!list) trips.set(c.trip.id, (list = []));
    list.push({ s, h: c.hours, k });
  }
  let chi = 0;
  let used = 0;
  for (const parts of trips.values()) {
    let o = 0;
    let e = 0;
    for (const p of parts) {
      const st = strata.get(p.s)!;
      o += p.k;
      e += st.T > 0 ? (p.h * st.n) / st.T : 0;
    }
    if (e > 0) {
      chi += ((o - e) * (o - e)) / e;
      used++;
    }
  }
  const df = used - strata.size;
  if (df < 3) return 1;
  return Math.min(maxPhi, Math.max(1, chi / df));
}

/** Extra hours at the current effect size before the interval would exclude 1. */
export function hoursToResolve(stats: BucketStats, maxHours = 200): number | null {
  if (stats.rawLogRR === null || stats.varLogRR === null) return null;
  const ln = Math.abs(stats.rawLogRR);
  if (ln < 1e-6) return null;
  const required = (ln / Z95) ** 2;
  if (stats.varLogRR <= required) return 0;
  const extra = stats.hours * (stats.varLogRR / required - 1);
  return extra > maxHours ? null : Math.ceil(extra);
}

export { Z95, SEP };
