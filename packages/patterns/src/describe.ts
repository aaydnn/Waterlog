import { WATER_TEMP_BAND_C } from './buckets'
import type { Confidence, Pattern } from './types'

/**
 * The words on the card. Pure and tested here rather than in the client so the vocabulary has one
 * home: `pattern_cache` stores a dimension and a bucket, never prose, exactly as packet §07
 * defines it.
 */

/** How each bucket reads inside a sentence, and the preposition that carries it. */
const PHRASES: Record<string, (bucket: string) => string> = {
  pressure_trend: (b) =>
    ({ falling: 'on falling pressure', rising: 'on rising pressure', stable: 'on steady pressure' })[b] ??
    `on ${b} pressure`,
  sky: (b) =>
    ({ clear: 'under clear skies', partly: 'under broken cloud', overcast: 'under overcast skies' })[b] ??
    `under ${b} skies`,
  wind: (b) =>
    ({ calm: 'in calm air', light: 'in a light breeze', strong: 'in strong wind' })[b] ?? `in ${b} wind`,
  water_temp: (b) => `in water of ${b} to ${Number(b) + WATER_TEMP_BAND_C}°C`,
  moon: (b) =>
    ({ new: 'on a new moon', waxing: 'on a waxing moon', full: 'on a full moon', waning: 'on a waning moon' })[b] ??
    `on a ${b} moon`,
  time_block: (b) =>
    ({
      dawn: 'in the dawn window',
      morning: 'through the morning',
      midday: 'at midday',
      evening: 'in the evening',
      dusk: 'in the dusk window',
      night: 'after dark',
    })[b] ?? `at ${b}`,
  season: (b) => `in ${b}`,
  lure_family: (b) => `on ${humanize(b)}`,
  lure_color: (b) => `on ${humanize(b)}`,
}

/** `soft_plastic` reads as "soft plastic" on a card, not as a database value. */
export function humanize(slug: string): string {
  return slug.replace(/_/g, ' ')
}

/** One dimension's bucket, as it reads in a sentence. */
export function describeBucket(dimension: string, bucket: string): string {
  const phrase = PHRASES[dimension]
  return phrase ? phrase(bucket) : `on ${humanize(bucket)}`
}

/** Multipliers are shown to one decimal: the precision the data supports and no more. */
export function formatMultiplier(multiplier: number): string {
  return `${multiplier.toFixed(1)}×`
}

/**
 * The card's plain-English statement.
 *
 * The same sentence serves a lift and a collapse. "0.4× as often" is as readable as "3.2× as
 * often", and packet §08 is explicit that a negative pattern is equally actionable and gets shown
 * on the same terms rather than being softened or hidden.
 */
export function describePattern(pattern: Pattern): string {
  const dimensions = pattern.dimension.split('+')
  const buckets = pattern.bucket.split('|')
  // Rendered from whatever parts line up. A cached row written by an older engine could name two
  // dimensions and carry one bucket; saying less is the right failure, and saying nonsense is not.
  const phrase = dimensions
    .filter((_, i) => i < buckets.length)
    .map((d, i) => describeBucket(d, buckets[i]!))
    .join(', ')
  return `You catch ${formatMultiplier(pattern.multiplier)} as often ${phrase}.`
}

/** The footer under the statement: what the claim rests on. */
export function describeSampleSize(pattern: Pattern): string {
  const hours = Number.isInteger(pattern.hours) ? String(pattern.hours) : pattern.hours.toFixed(1)
  const catches = `${pattern.catches} ${pattern.catches === 1 ? 'catch' : 'catches'}`
  const trips = `${pattern.trips} ${pattern.trips === 1 ? 'trip' : 'trips'}`
  return `${catches} · ${hours} hrs · ${trips}`
}

/** The badge. "Early signal" is labelled as one and never dressed up as more. */
export function confidenceLabel(confidence: Confidence): string {
  return { early: 'Early signal', promising: 'Promising', solid: 'Solid' }[confidence]
}

export function describeConfidence(pattern: Pattern): string {
  return confidenceLabel(pattern.confidence)
}
