/** Confidence tiers from packet §08. Deliberately heuristic rather than p-values: an angler can
 * check "10+ catches across 5+ trips" against their own journal, and honesty they can verify
 * beats rigor they cannot. */
export type Confidence = 'early' | 'promising' | 'solid'

/**
 * One hour an angler was on the water, with the conditions that held during it. Exactly the
 * `conditions` rows that carry `trip_id` and `hour_bucket`, joined to their trip's water.
 *
 * These are the denominator. Every hour of every trip gets one, skunked or not, which is the
 * design decision packet §07 calls the one that makes the analytics honest.
 */
export interface ExposureHour {
  trip_id: string
  /** Scope key. Null for a trip with no water recorded — such hours count in `all` only. */
  water_body_id: string | null
  /** Epoch hour: `floor(ms / 3_600_000)`. */
  hour_bucket: number
  pressure_trend: string | null
  cloud_pct: number | null
  wind_kph: number | null
  water_temp_c: number | null
  /** 0..1, 0 = new moon. */
  moon_phase: number | null
  /** Signed; negative is before sunrise. */
  minutes_from_sunrise: number | null
  season: string | null
}

/** One catch, with the offering it came on. The numerator. */
export interface CatchEvent {
  id: string
  trip_id: string
  caught_at: number
  lure_family: string | null
  lure_color: string | null
}

export interface PatternInput {
  hours: ExposureHour[]
  catches: CatchEvent[]
}

/** One row of `pattern_cache`, before the cron worker stamps an id and a timestamp on it. */
export interface Pattern {
  /** `'all'` or a water_body_id. */
  scope: string
  /** `'lure_color'`, `'pressure_trend'`, `'lure_family+pressure_trend'`. */
  dimension: string
  /** `'chartreuse'`, `'falling'`, `'spinnerbait|falling'`. */
  bucket: string
  catches: number
  hours: number
  rate: number
  baseline_rate: number
  multiplier: number
  confidence: Confidence
  /** Distinct trips contributing catches. The guard against one lucky evening. */
  trips: number
}

export interface PatternReport {
  patterns: Pattern[]
  /**
   * Catches that landed in no exposure hour, so no rate could count them: their trip is still
   * open, or its hour never enriched. Reported rather than swallowed — a feed thinner than the
   * journal suggests should be explainable.
   */
  unattributed_catches: number
  /** Scopes dropped for having under `MIN_BASELINE_HOURS` on the water. */
  skipped_scopes: string[]
}
