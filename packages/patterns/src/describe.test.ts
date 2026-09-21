import { describe, expect, it } from 'vitest'
import { confidenceFor } from './confidence'
import {
  describeBucket,
  describeConfidence,
  describePattern,
  describeSampleSize,
  formatMultiplier,
  humanize,
} from './describe'
import type { Pattern } from './types'

const pattern = (overrides: Partial<Pattern> = {}): Pattern => ({
  scope: 'all',
  dimension: 'lure_color',
  bucket: 'chartreuse',
  catches: 11,
  hours: 14,
  rate: 0.786,
  baseline_rate: 0.245,
  multiplier: 3.2,
  confidence: 'solid',
  trips: 6,
  ...overrides,
})

describe('confidence tiers', () => {
  it.each([
    [10, 10, 5, 'solid'],
    [9, 10, 5, 'promising'],
    [10, 9, 5, 'promising'],
    [10, 10, 4, 'promising'],
    [5, 6, 3, 'promising'],
    [4, 6, 3, 'early'],
    [5, 5.9, 3, 'early'],
    [5, 6, 2, 'early'],
    [3, 3, 1, 'early'],
  ])('%d catches, %d hours, %d trips is %s', (catches, hours, trips, expected) => {
    expect(confidenceFor(catches, hours, trips)).toBe(expected)
  })

  it('will not call one lucky evening solid, however many fish it held', () => {
    // Eleven fish in a single session is one observation, not eleven.
    expect(confidenceFor(11, 12, 1)).toBe('early')
  })
})

describe('the words on a card', () => {
  it('states a lift in plain English', () => {
    expect(describePattern(pattern())).toBe('You catch 3.2× as often on chartreuse.')
  })

  it('states a collapse the same way, without softening it', () => {
    expect(describePattern(pattern({ dimension: 'sky', bucket: 'clear', multiplier: 0.4 }))).toBe(
      'You catch 0.4× as often under clear skies.',
    )
  })

  it('reads a pairing as one sentence', () => {
    expect(
      describePattern(
        pattern({ dimension: 'lure_color+pressure_trend', bucket: 'chartreuse|falling' }),
      ),
    ).toBe('You catch 3.2× as often on chartreuse, on falling pressure.')
  })

  it.each([
    ['pressure_trend', 'falling', 'on falling pressure'],
    ['pressure_trend', 'rising', 'on rising pressure'],
    ['pressure_trend', 'stable', 'on steady pressure'],
    ['sky', 'clear', 'under clear skies'],
    ['sky', 'partly', 'under broken cloud'],
    ['sky', 'overcast', 'under overcast skies'],
    ['wind', 'calm', 'in calm air'],
    ['wind', 'light', 'in a light breeze'],
    ['wind', 'strong', 'in strong wind'],
    ['water_temp', '15', 'in water of 15 to 20°C'],
    ['moon', 'new', 'on a new moon'],
    ['moon', 'waxing', 'on a waxing moon'],
    ['moon', 'full', 'on a full moon'],
    ['moon', 'waning', 'on a waning moon'],
    ['time_block', 'dawn', 'in the dawn window'],
    ['time_block', 'morning', 'through the morning'],
    ['time_block', 'midday', 'at midday'],
    ['time_block', 'evening', 'in the evening'],
    ['time_block', 'dusk', 'in the dusk window'],
    ['time_block', 'night', 'after dark'],
    ['season', 'spring', 'in spring'],
    ['lure_family', 'soft_plastic', 'on soft plastic'],
    ['lure_color', 'chartreuse', 'on chartreuse'],
  ])('renders %s / %s as "%s"', (dimension, bucket, expected) => {
    expect(describeBucket(dimension, bucket)).toBe(expected)
  })

  it('renders only the parts that line up when a cached row is malformed', () => {
    const malformed = pattern({ dimension: 'lure_color+pressure_trend', bucket: 'chartreuse' })
    expect(describePattern(malformed)).toBe('You catch 3.2× as often on chartreuse.')
  })

  it('falls back to the raw value for a bucket it has no phrase for', () => {
    // A dimension added later should read awkwardly, never crash or print a database value.
    expect(describeBucket('depth_band', 'deep_water')).toBe('on deep water')
    expect(describeBucket('pressure_trend', 'plummeting')).toBe('on plummeting pressure')
    expect(describeBucket('sky', 'foggy')).toBe('under foggy skies')
    expect(describeBucket('wind', 'gale')).toBe('in gale wind')
    expect(describeBucket('moon', 'blue')).toBe('on a blue moon')
    expect(describeBucket('time_block', 'siesta')).toBe('at siesta')
  })

  it('humanizes a slug without touching a plain word', () => {
    expect(humanize('soft_plastic')).toBe('soft plastic')
    expect(humanize('chartreuse')).toBe('chartreuse')
  })

  it('shows a multiplier to one decimal, the precision the data supports', () => {
    expect(formatMultiplier(3.24)).toBe('3.2×')
    expect(formatMultiplier(1)).toBe('1.0×')
  })
})

describe('the footer under the statement', () => {
  it('shows what the claim rests on', () => {
    expect(describeSampleSize(pattern())).toBe('11 catches · 14 hrs · 6 trips')
  })

  it('rounds an apportioned hour count rather than printing a repeating decimal', () => {
    expect(describeSampleSize(pattern({ hours: 7.3333333 }))).toBe('11 catches · 7.3 hrs · 6 trips')
  })

  it('counts one of anything in the singular', () => {
    expect(describeSampleSize(pattern({ catches: 1, hours: 3, trips: 1 }))).toBe(
      '1 catch · 3 hrs · 1 trip',
    )
  })
})

describe('the confidence badge', () => {
  it.each([
    ['early', 'Early signal'],
    ['promising', 'Promising'],
    ['solid', 'Solid'],
  ] as const)('labels %s as "%s"', (confidence, expected) => {
    expect(describeConfidence(pattern({ confidence }))).toBe(expected)
  })
})
