import type { Cell, ConditionFeatures, ScopeId } from './types';

export type Population = 'clock' | 'rod';

export interface DimensionDef {
  key: string;
  population: Population;
  /** Parents for combo suppression (a specific offering is a child of its family and color). */
  parents: string[];
  bucket(cell: Cell): string | null;
}

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function sky(f: ConditionFeatures): string | null {
  if (!num(f.cloudPct)) return null;
  return f.cloudPct < 25 ? 'clear' : f.cloudPct < 70 ? 'partly' : 'overcast';
}
export function wind(f: ConditionFeatures): string | null {
  if (!num(f.windKph)) return null;
  return f.windKph < 8 ? 'calm' : f.windKph <= 20 ? 'light' : 'strong';
}
export function waterTemp(f: ConditionFeatures): string | null {
  if (!num(f.waterTempC)) return null;
  const lo = Math.floor(f.waterTempC / 5) * 5;
  return `${lo}-${lo + 5}c`;
}
/** Same temperature, opposite direction (idea 14). */
export function waterTempTrend(f: ConditionFeatures): string | null {
  if (!num(f.waterTempDelta72hC)) return null;
  return f.waterTempDelta72hC <= -1.5 ? 'cooling' : f.waterTempDelta72hC >= 1.5 ? 'warming' : 'steady';
}
/** Conditions have a memory (idea 13). */
export function rainPrev48h(f: ConditionFeatures): string | null {
  if (!num(f.precipPrev48hMm)) return null;
  return f.precipPrev48hMm < 2 ? 'dry' : f.precipPrev48hMm < 12 ? 'some_rain' : 'heavy_rain';
}
export function flowTrend(f: ConditionFeatures): string | null {
  if (!num(f.dischargeDelta24hPct)) return null;
  return f.dischargeDelta24hPct <= -10 ? 'falling' : f.dischargeDelta24hPct >= 10 ? 'rising' : 'stable';
}
export function moon(f: ConditionFeatures): string | null {
  if (!num(f.moonPhase)) return null;
  const p = ((f.moonPhase % 1) + 1) % 1;
  return p < 0.125 || p >= 0.875 ? 'new' : p < 0.375 ? 'first_quarter' : p < 0.625 ? 'full' : 'last_quarter';
}
/** Uses real sunset when available (idea 22); falls back to the MVP sunrise-offset approximation. */
export function timeBlock(f: ConditionFeatures): string | null {
  if (!num(f.minutesFromSunrise)) return null;
  const mfs = f.minutesFromSunrise;
  const mts = num(f.minutesToSunset) ? f.minutesToSunset : null;
  if (Math.abs(mfs) <= 90) return 'dawn';
  if (mts !== null && Math.abs(mts) <= 90) return 'dusk';
  if (mfs < -90 || (mts !== null && mts < -90)) return 'night';
  if (mfs < 300) return 'morning';
  if (mts !== null) return mts <= 240 ? 'evening' : 'midday';
  if (mfs < 600) return 'midday';
  if (mfs < 750) return 'evening';
  if (mfs < 930) return 'dusk';
  return 'night';
}

const feat = (fn: (f: ConditionFeatures) => string | null) => (c: Cell) => fn(c.features);

export const SINGLE_DIMENSIONS: DimensionDef[] = [
  { key: 'offering_family', population: 'rod', parents: [], bucket: (c) => c.offering?.family ?? null },
  { key: 'offering_color', population: 'rod', parents: [], bucket: (c) => c.offering?.color ?? null },
  { key: 'offering', population: 'rod', parents: ['offering_family', 'offering_color'], bucket: (c) => c.offering?.id ?? null },
  { key: 'pressure_trend', population: 'clock', parents: [], bucket: (c) => c.features.pressureTrend ?? null },
  { key: 'sky', population: 'clock', parents: [], bucket: feat(sky) },
  { key: 'wind', population: 'clock', parents: [], bucket: feat(wind) },
  { key: 'water_temp', population: 'clock', parents: [], bucket: feat(waterTemp) },
  { key: 'water_temp_trend', population: 'clock', parents: [], bucket: feat(waterTempTrend) },
  { key: 'rain_prev_48h', population: 'clock', parents: [], bucket: feat(rainPrev48h) },
  { key: 'flow_trend', population: 'clock', parents: [], bucket: feat(flowTrend) },
  { key: 'moon', population: 'clock', parents: [], bucket: feat(moon) },
  { key: 'time_block', population: 'clock', parents: [], bucket: feat(timeBlock) },
  { key: 'season', population: 'clock', parents: [], bucket: (c) => c.features.season ?? null },
  { key: 'water_body', population: 'clock', parents: [], bucket: (c) => c.trip.waterBodyId },
];

/** Memoized bucket lookup. Safe because cells are immutable once built. */
export function bucketOf(d: DimensionDef, c: Cell): string | null {
  const memo = (c.memo ??= {});
  const hit = memo[d.key];
  if (hit !== undefined) return hit;
  const v = d.bucket(c);
  memo[d.key] = v;
  return v;
}

const byKey = new Map(SINGLE_DIMENSIONS.map((d) => [d.key, d]));
export const getSingle = (k: string): DimensionDef | undefined => byKey.get(k);

/** Curated fishing interactions tested even when neither parent is strong alone (idea 10). */
export const CURATED_COMBOS: ReadonlyArray<readonly [string, string]> = [
  ['offering_family', 'pressure_trend'],
  ['offering_family', 'sky'],
  ['offering_family', 'wind'],
  ['offering_family', 'water_temp'],
  ['offering_family', 'water_temp_trend'],
  ['offering_family', 'time_block'],
  ['offering_color', 'sky'],
  ['time_block', 'season'],
  ['pressure_trend', 'season'],
  ['water_temp_trend', 'time_block'],
];

export function comboDimension(a: string, b: string): DimensionDef | undefined {
  const [x, y] = [a, b].sort();
  const da = getSingle(x!);
  const db = getSingle(y!);
  if (!da || !db || da.key === db.key) return undefined;
  return {
    key: `${da.key}+${db.key}`,
    population: da.population === 'rod' || db.population === 'rod' ? 'rod' : 'clock',
    parents: [da.key, db.key],
    bucket: (c) => {
      const u = bucketOf(da, c);
      const v = bucketOf(db, c);
      return u === null || v === null ? null : `${u}|${v}`;
    },
  };
}

export function resolveDimension(key: string): DimensionDef | undefined {
  if (!key.includes('+')) return getSingle(key);
  const [a, b] = key.split('+');
  return comboDimension(a!, b!);
}

/** Canonical combo form: dimensions sorted, bucket parts reordered to match ("jig|full" for offering_family+moon → "full|jig"). */
export function canonicalize(dimension: string, bucket: string): { dimension: string; bucket: string } {
  if (!dimension.includes('+')) return { dimension, bucket };
  const dims = dimension.split('+');
  const parts = bucket.split('|');
  const pairs = dims.map((d, i) => [d, parts[i] ?? ''] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { dimension: pairs.map((p) => p[0]).join('+'), bucket: pairs.map((p) => p[1]).join('|') };
}

export function dimensionsForScope(scopeId: ScopeId): DimensionDef[] {
  return SINGLE_DIMENSIONS.filter((d) => !(d.key === 'water_body' && scopeId !== 'all'));
}

/** Condition dimensions used for competing explanations and gap analysis (idea 24/40). */
export const CONTEXT_DIMENSIONS = ['water_body', 'season', 'time_block', 'sky', 'wind', 'pressure_trend', 'water_temp_trend'];
