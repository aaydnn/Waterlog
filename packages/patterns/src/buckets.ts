import type { CatchEvent, ExposureHour } from './types'

/**
 * Every bucketer returns null for a reading it does not have, and null drops that hour from that
 * dimension only. Partial coverage is the normal case, not an edge one: gauges do not cover every
 * water (ADR-0008, ADR-0010) and a missing reading must never be read as a zero.
 */
export type ConditionBucketer = (hour: ExposureHour) => string | null
export type LureBucketer = (event: CatchEvent) => string | null

/** Cloud cover bands. The packet names the three but not their cuts; these are the standard
 * meteorological ones — clear to a quarter cover, overcast from three quarters up. */
export const CLEAR_MAX_PCT = 25
export const OVERCAST_MIN_PCT = 75

export function skyBucket(cloudPct: number | null): string | null {
  if (cloudPct === null) return null
  if (cloudPct < CLEAR_MAX_PCT) return 'clear'
  if (cloudPct < OVERCAST_MIN_PCT) return 'partly'
  return 'overcast'
}

/** Packet §08: calm <8 · light 8–20 · strong >20 kph. Both edges belong to `light`. */
export const CALM_MAX_KPH = 8
export const LIGHT_MAX_KPH = 20

export function windBucket(windKph: number | null): string | null {
  if (windKph === null) return null
  if (windKph < CALM_MAX_KPH) return 'calm'
  if (windKph <= LIGHT_MAX_KPH) return 'light'
  return 'strong'
}

/** 5°C-wide bands, keyed by the band's lower bound so the key stays unambiguous below zero.
 * `describeBucket` renders it as a range. */
export const WATER_TEMP_BAND_C = 5

export function waterTempBucket(waterTempC: number | null): string | null {
  if (waterTempC === null) return null
  return String(Math.floor(waterTempC / WATER_TEMP_BAND_C) * WATER_TEMP_BAND_C)
}

/** Phase quartiles (packet §08). suncalc's phase runs 0 = new, 0.5 = full, back to 1 = new. */
export function moonBucket(moonPhase: number | null): string | null {
  if (moonPhase === null) return null
  if (moonPhase < 0.25) return 'new'
  if (moonPhase < 0.5) return 'waxing'
  if (moonPhase < 0.75) return 'full'
  return 'waning'
}

/**
 * Time blocks, all measured from sunrise as packet §08 specifies.
 *
 * Dawn and dusk are the ±90 minute windows the packet names. Sunrise is a real number in the
 * data; sunset is not — `conditions` stores no sunset offset — so dusk is anchored at 12.5 hours
 * after sunrise, an equinox day. That is right within the hour across the mid-latitudes this
 * product is used in and drifts in high-latitude midsummer. Storing a sunset offset would make it
 * exact and needs a column, so it stays a candidate for later rather than a guess dressed up as a
 * measurement.
 */
export const DAWN_WINDOW_MIN = 90
export const MORNING_END_MIN = 300
export const MIDDAY_END_MIN = 540
export const EVENING_END_MIN = 660
export const SUNSET_OFFSET_MIN = 750

export function timeBlockBucket(minutesFromSunrise: number | null): string | null {
  if (minutesFromSunrise === null) return null
  const m = minutesFromSunrise
  if (m < -DAWN_WINDOW_MIN) return 'night'
  if (m <= DAWN_WINDOW_MIN) return 'dawn'
  if (m <= MORNING_END_MIN) return 'morning'
  if (m <= MIDDAY_END_MIN) return 'midday'
  if (m <= EVENING_END_MIN) return 'evening'
  if (m <= SUNSET_OFFSET_MIN + DAWN_WINDOW_MIN) return 'dusk'
  return 'night'
}

/** Already classified upstream, and passed through so an absent value stays absent rather than
 * becoming a bucket called "null". */
function passThrough(value: string | null): string | null {
  return value === null || value === '' ? null : value
}

export interface Dimension {
  id: string
  /** A condition is a property of an hour. A lure is a property of a catch, which is why the two
   * cannot share a denominator — see `exposure.ts`. */
  kind: 'condition' | 'lure'
  ofHour?: ConditionBucketer
  ofCatch?: LureBucketer
}

/** The MVP dimension set, in the order patterns are grouped and reported. */
export const DIMENSIONS: Dimension[] = [
  { id: 'lure_family', kind: 'lure', ofCatch: (c) => passThrough(c.lure_family) },
  { id: 'lure_color', kind: 'lure', ofCatch: (c) => passThrough(c.lure_color) },
  { id: 'pressure_trend', kind: 'condition', ofHour: (h) => passThrough(h.pressure_trend) },
  { id: 'sky', kind: 'condition', ofHour: (h) => skyBucket(h.cloud_pct) },
  { id: 'wind', kind: 'condition', ofHour: (h) => windBucket(h.wind_kph) },
  { id: 'water_temp', kind: 'condition', ofHour: (h) => waterTempBucket(h.water_temp_c) },
  { id: 'moon', kind: 'condition', ofHour: (h) => moonBucket(h.moon_phase) },
  { id: 'time_block', kind: 'condition', ofHour: (h) => timeBlockBucket(h.minutes_from_sunrise) },
  { id: 'season', kind: 'condition', ofHour: (h) => passThrough(h.season) },
]
