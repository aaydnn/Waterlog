// The pattern engine (packet §08). Pure TypeScript, zero I/O: the cron worker feeds it rows and
// writes back what it returns. 100% branch coverage is required, and a property test asserts that
// shuffling the input rows never changes the output.

export type { ComputeOptions } from './compute'
export type {
  CatchEvent,
  Confidence,
  ExposureHour,
  Pattern,
  PatternInput,
  PatternReport,
} from './types'

export {
  ALL_SCOPE,
  COMBO_UPLIFT,
  HOUR_MS,
  MIN_BASELINE_HOURS,
  MIN_BUCKET_CATCHES,
  MIN_BUCKET_HOURS,
  STRONG_MULTIPLIER,
  TOP_DIMENSIONS_FOR_COMBOS,
  WEAK_MULTIPLIER,
  attributeCatch,
  computePatterns,
  scopesIn,
  strength,
  surfaces,
} from './compute'

export { PROMISING, SOLID, confidenceFor } from './confidence'

export type { Dimension } from './buckets'
export {
  CALM_MAX_KPH,
  CLEAR_MAX_PCT,
  DAWN_WINDOW_MIN,
  DIMENSIONS,
  LIGHT_MAX_KPH,
  OVERCAST_MIN_PCT,
  WATER_TEMP_BAND_C,
  moonBucket,
  skyBucket,
  timeBlockBucket,
  waterTempBucket,
  windBucket,
} from './buckets'

export {
  confidenceLabel,
  describeBucket,
  describeConfidence,
  describePattern,
  describeSampleSize,
  formatMultiplier,
  humanize,
} from './describe'
