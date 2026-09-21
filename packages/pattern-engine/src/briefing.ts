import { DEFAULT_CONFIG } from './config';
import { getSingle } from './dimensions';
import { buildExposure } from './exposure';
import { weightedQuantile } from './stats/distributions';
import type { Cell, ConditionFeatures, EngineInput, EngineResult, Finding, Ms, ScopeId, TripMeta } from './types';

export interface BriefingInput {
  history: EngineInput;
  result: EngineResult;
  waterBodyId: string | null;
  forecast: ReadonlyArray<{ start: Ms; end: Ms; features: ConditionFeatures }>;
  /** "I have 75 minutes" (idea 49). */
  availableMinutes?: number;
}

export interface RankedOption {
  dimension: string;
  bucket: string;
  multiplier: number;
  basis: string;
  tier: Finding['tier'];
  /** Options sharing a group number are not meaningfully separable (idea 12). */
  group: number;
}

export interface Analog {
  tripId: string;
  startedAt: Ms;
  catches: number;
  hours: number;
  distance: number;
  differences: Array<{ feature: string; past: number; forecast: number }>;
}

export interface Briefing {
  scopeUsed: ScopeId;
  fellBackToAllWaters: boolean;
  confidence: 'low' | 'medium' | 'high';
  hourly: Array<{ start: Ms; score: number; matched: string[] }>;
  bestWindow: { start: Ms; end: Ms; score: number } | null;
  throw: RankedOption[];
  avoid: RankedOption[];
  outOfExperience: Array<{ feature: string; forecast: number | string; usualRange: [number, number] | null; summary: string }>;
  productiveAnalogs: Analog[];
  unproductiveAnalogs: Analog[];
}

const TIER_W = { early: 0.25, promising: 0.6, solid: 1 } as const;
const NUMERIC: Array<keyof ConditionFeatures> = ['waterTempC', 'airTempC', 'windKph', 'cloudPct', 'dischargeCms', 'waterTempDelta72hC'];

function fakeCell(features: ConditionFeatures, waterBodyId: string | null, start: Ms, end: Ms): Cell {
  const trip: TripMeta = { id: '_forecast', waterBodyId, startedAt: start, endedAt: end, week: 0, targetSpecies: null, fishableHours: 0, hasOfferingSessions: false };
  return { trip, start, end, hours: (end - start) / 3_600_000, quality: 'measured', features, offering: null, catches: [] };
}

export function buildBriefing(b: BriefingInput): Briefing {
  const config = { ...DEFAULT_CONFIG, ...b.history.config };
  const scoped = b.result.families.find((f) => f.outcome === 'all' && f.scopeId === b.waterBodyId);
  const allFam = b.result.families.find((f) => f.outcome === 'all' && f.scopeId === 'all');
  const scopeUsed: ScopeId = scoped ? scoped.scopeId : 'all';
  const fromScope = scoped?.findings ?? [];
  const seen = new Set(fromScope.map((f) => `${f.stats.dimension}::${f.stats.bucket}`));
  const pool = [...fromScope, ...(allFam?.findings ?? []).filter((f) => !seen.has(`${f.stats.dimension}::${f.stats.bucket}`) && scoped !== allFam)];

  const slices = b.forecast.slice().sort((x, y) => x.start - y.start);
  const sliceCells = slices.map((s) => fakeCell(s.features, b.waterBodyId, s.start, s.end));

  const componentMatch = (f: Finding, cell: Cell): { matches: boolean; rod: Array<[string, string]> } => {
    const dims = f.stats.dimension.split('+');
    const buckets = f.stats.bucket.split('|');
    const rod: Array<[string, string]> = [];
    for (let i = 0; i < dims.length; i++) {
      const d = getSingle(dims[i]!)!;
      if (d.population === 'rod') rod.push([d.key, buckets[i]!]);
      else if (d.bucket(cell) !== buckets[i]) return { matches: false, rod };
    }
    return { matches: true, rod };
  };

  const hourly = sliceCells.map((cell) => {
    let score = 0;
    const matched: string[] = [];
    for (const f of pool) {
      const m = componentMatch(f, cell);
      if (!m.matches) continue;
      matched.push(f.key);
      if (m.rod.length === 0) score += f.stats.logRR * TIER_W[f.tier] * (f.confounders.length ? 0.5 : 1);
    }
    return { start: cell.start, score, matched };
  });

  let bestWindow: Briefing['bestWindow'] = null;
  const k = b.availableMinutes ? Math.max(1, Math.ceil(b.availableMinutes / 60)) : 0;
  if (k > 0 && hourly.length >= k) {
    for (let i = 0; i + k <= hourly.length; i++) {
      const score = hourly.slice(i, i + k).reduce((s, h) => s + h.score, 0);
      if (!bestWindow || score > bestWindow.score) bestWindow = { start: slices[i]!.start, end: slices[i + k - 1]!.end, score };
    }
  }

  // Offering ranking: most specific matching evidence per option, weighted by forecast coverage.
  const options = new Map<string, { f: Finding; coverage: number; score: number; rodKey: [string, string] }>();
  for (const f of pool) {
    let hits = 0;
    let rodKey: [string, string] | null = null;
    for (const cell of sliceCells) {
      const m = componentMatch(f, cell);
      if (m.rod.length !== 1) break;
      rodKey = m.rod[0]!;
      if (m.matches) hits++;
    }
    if (!rodKey || hits === 0) continue;
    const coverage = hits / sliceCells.length;
    const key = rodKey.join('::');
    const prev = options.get(key);
    const specificity = (x: Finding) => (x.kind === 'combo' ? 2 : 1) * 10 + TIER_W[x.tier];
    if (!prev || specificity(f) > specificity(prev.f) || (specificity(f) === specificity(prev.f) && coverage > prev.coverage))
      options.set(key, { f, coverage, score: f.stats.logRR * coverage, rodKey });
  }
  const rank = (entries: Array<{ f: Finding; score: number; rodKey: [string, string] }>, sign: 1 | -1): RankedOption[] => {
    const sorted = entries.filter((e) => Math.sign(e.score) === sign).sort((x, y) => sign * (y.score - x.score) || (x.f.key < y.f.key ? -1 : 1));
    let group = 0;
    let anchor: (typeof sorted)[number] | null = null;
    return sorted.map((e) => {
      if (!anchor || Math.abs(anchor.score - e.score) > 1.64 * Math.sqrt(anchor.f.stats.postVar + e.f.stats.postVar)) {
        group++;
        anchor = e;
      }
      return { dimension: e.rodKey[0], bucket: e.rodKey[1], multiplier: Math.exp(e.score), basis: e.f.key, tier: e.f.tier, group };
    });
  };
  const optionList = [...options.values()];

  // Boundary of experience (idea 11) and analogs from both sides (idea 65).
  const exposure = buildExposure(b.history, config);
  const cells = exposure.clock.filter((c) => scopeUsed === 'all' || c.trip.waterBodyId === scopeUsed);
  const outOfExperience: Briefing['outOfExperience'] = [];
  const mean = (key: keyof ConditionFeatures, list: ReadonlyArray<{ features: ConditionFeatures; hours?: number }>) => {
    let s = 0;
    let w = 0;
    for (const x of list) {
      const v = x.features[key];
      if (typeof v === 'number') {
        const h = x.hours ?? 1;
        s += v * h;
        w += h;
      }
    }
    return w > 0 ? s / w : null;
  };
  for (const key of ['waterTempC', 'airTempC', 'windKph', 'dischargeCms'] as const) {
    const pairs = cells.flatMap((c) => (typeof c.features[key] === 'number' ? [[c.features[key] as number, c.hours] as const] : []));
    const known = pairs.reduce((s, [, h]) => s + h, 0);
    const fv = mean(key, slices);
    if (fv === null || known < 10) continue;
    const lo = weightedQuantile(pairs, 0.05)!;
    const hi = weightedQuantile(pairs, 0.95)!;
    if (fv < lo || fv > hi)
      outOfExperience.push({
        feature: key,
        forecast: fv,
        usualRange: [lo, hi],
        summary: `Forecast ${key} of ${fv.toFixed(1)} is outside what you've fished here (${lo.toFixed(1)}–${hi.toFixed(1)}). Your usual patterns may not transfer.`,
      });
  }
  const season = slices[0]?.features.season;
  if (season) {
    const seasonHours = cells.filter((c) => c.features.season === season).reduce((s, c) => s + c.hours, 0);
    if (seasonHours < 2) outOfExperience.push({ feature: 'season', forecast: season, usualRange: null, summary: `You have almost no ${season} history here.` });
  }

  const tripCells = new Map<string, Cell[]>();
  for (const c of cells) tripCells.set(c.trip.id, [...(tripCells.get(c.trip.id) ?? []), c]);
  const tripVec = [...tripCells.entries()].map(([id, cs]) => {
    const vec: Record<string, number | null> = {};
    for (const key of NUMERIC) vec[key] = mean(key, cs);
    return { id, cs, vec, catches: cs.reduce((s, c) => s + c.catches.length, 0), hours: cs.reduce((s, c) => s + c.hours, 0), season: cs[0]!.features.season ?? null };
  });
  const fVec: Record<string, number | null> = {};
  for (const key of NUMERIC) fVec[key] = mean(key, slices);
  const sd: Record<string, number> = {};
  for (const key of NUMERIC) {
    const vals = tripVec.map((t) => t.vec[key]).filter((v): v is number => v !== null && v !== undefined);
    const m = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
    sd[key] = vals.length >= 3 ? Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / (vals.length - 1)) || 1 : 1;
  }
  const rates = tripVec.map((t) => (t.hours > 0 ? t.catches / t.hours : 0)).sort((x, y) => x - y);
  const medianRate = rates.length ? rates[Math.floor((rates.length - 1) / 2)]! : 0;
  const analogs = tripVec
    .map((t) => {
      let sq = 0;
      let used = 0;
      let penalty = 0;
      const diffs: Analog['differences'] = [];
      for (const key of NUMERIC) {
        const a = t.vec[key];
        const f = fVec[key];
        if (a === null || a === undefined || f === null || f === undefined) {
          penalty += 0.25;
          continue;
        }
        const z = (a - f) / sd[key]!;
        sq += z * z;
        used++;
        diffs.push({ feature: key, past: a, forecast: f });
      }
      if (season && t.season !== season) penalty += 0.75;
      diffs.sort((x, y) => Math.abs(y.past - y.forecast) / sd[y.feature]! - Math.abs(x.past - x.forecast) / sd[x.feature]!);
      const tm = t.cs[0]!.trip;
      return {
        tripId: t.id,
        startedAt: tm.startedAt,
        catches: t.catches,
        hours: t.hours,
        distance: (used ? Math.sqrt(sq / used) : 2) + penalty,
        differences: diffs.slice(0, 2),
        productive: t.catches > 0 && t.hours > 0 && t.catches / t.hours >= medianRate,
      };
    })
    .sort((x, y) => x.distance - y.distance || x.startedAt - y.startedAt);
  const strip = ({ productive: _p, ...a }: Analog & { productive: boolean }): Analog => a;

  const matchedTiers = new Set(hourly.flatMap((h) => h.matched).map((key) => pool.find((f) => f.key === key)!.tier));
  const confirmed = b.result.records.some((r) => r.state === 'confirmed' && hourly.some((h) => h.matched.includes(r.key)));
  const confidence: Briefing['confidence'] =
    outOfExperience.length > 0 || !(matchedTiers.has('promising') || matchedTiers.has('solid'))
      ? 'low'
      : matchedTiers.has('solid') || confirmed
        ? 'high'
        : 'medium';

  return {
    scopeUsed,
    fellBackToAllWaters: !scoped,
    confidence,
    hourly,
    bestWindow,
    throw: rank(optionList, 1),
    avoid: rank(optionList, -1),
    outOfExperience,
    productiveAnalogs: analogs.filter((a) => a.productive).slice(0, 3).map(strip),
    unproductiveAnalogs: analogs.filter((a) => !a.productive).slice(0, 2).map(strip),
  };
}

