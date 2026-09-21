import { describe, expect, it } from 'vitest'
import {
  DIMENSIONS,
  moonBucket,
  skyBucket,
  timeBlockBucket,
  waterTempBucket,
  windBucket,
} from './buckets'
import type { CatchEvent, ExposureHour } from './types'

// Every band edge is tested from both sides. An edge is where an off-by-one hides, and these
// bands come straight out of packet §08 — getting one wrong silently reclassifies real fishing.

const hour = (overrides: Partial<ExposureHour> = {}): ExposureHour => ({
  trip_id: 't1',
  water_body_id: null,
  hour_bucket: 0,
  pressure_trend: null,
  cloud_pct: null,
  wind_kph: null,
  water_temp_c: null,
  moon_phase: null,
  minutes_from_sunrise: null,
  season: null,
  ...overrides,
})

describe('skyBucket', () => {
  it('drops an hour with no cloud reading rather than calling it clear', () => {
    expect(skyBucket(null)).toBeNull()
  })

  it.each([
    [0, 'clear'],
    [24.9, 'clear'],
    [25, 'partly'],
    [74.9, 'partly'],
    [75, 'overcast'],
    [100, 'overcast'],
  ])('bands %d%% cloud as %s', (pct, expected) => {
    expect(skyBucket(pct)).toBe(expected)
  })
})

describe('windBucket', () => {
  it('drops an hour with no wind reading', () => {
    expect(windBucket(null)).toBeNull()
  })

  it.each([
    [0, 'calm'],
    [7.9, 'calm'],
    [8, 'light'],
    [20, 'light'],
    [20.1, 'strong'],
  ])('bands %d kph as %s — both edges belong to light', (kph, expected) => {
    expect(windBucket(kph)).toBe(expected)
  })
})

describe('waterTempBucket', () => {
  it('drops an hour with no water temperature', () => {
    expect(waterTempBucket(null)).toBeNull()
  })

  it.each([
    [0, '0'],
    [4.9, '0'],
    [5, '5'],
    [19.9, '15'],
    [20, '20'],
  ])('puts %d°C in the band starting at %s', (celsius, expected) => {
    expect(waterTempBucket(celsius)).toBe(expected)
  })

  it('keys sub-zero water by the band floor, so ice-out water never collides with 0-5', () => {
    expect(waterTempBucket(-0.5)).toBe('-5')
    expect(waterTempBucket(-5)).toBe('-5')
    expect(waterTempBucket(-5.1)).toBe('-10')
  })
})

describe('moonBucket', () => {
  it('drops an hour with no moon phase', () => {
    expect(moonBucket(null)).toBeNull()
  })

  it.each([
    [0, 'new'],
    [0.249, 'new'],
    [0.25, 'waxing'],
    [0.499, 'waxing'],
    [0.5, 'full'],
    [0.749, 'full'],
    [0.75, 'waning'],
    [1, 'waning'],
  ])('puts phase %d in the %s quartile', (phase, expected) => {
    expect(moonBucket(phase)).toBe(expected)
  })
})

describe('timeBlockBucket', () => {
  it('drops an hour with no sunrise offset', () => {
    expect(timeBlockBucket(null)).toBeNull()
  })

  it.each([
    [-91, 'night'],
    [-90, 'dawn'],
    [0, 'dawn'],
    [90, 'dawn'],
    [91, 'morning'],
    [300, 'morning'],
    [301, 'midday'],
    [540, 'midday'],
    [541, 'evening'],
    [660, 'evening'],
    [661, 'dusk'],
    [840, 'dusk'],
    [841, 'night'],
  ])('puts %d minutes from sunrise in %s', (minutes, expected) => {
    expect(timeBlockBucket(minutes)).toBe(expected)
  })
})

describe('the dimension set', () => {
  const event: CatchEvent = {
    id: 'c1',
    trip_id: 't1',
    caught_at: 0,
    lure_family: 'spinnerbait',
    lure_color: 'chartreuse',
  }

  it('reads every condition dimension off an hour', () => {
    const full = hour({
      pressure_trend: 'falling',
      cloud_pct: 10,
      wind_kph: 12,
      water_temp_c: 17,
      moon_phase: 0.6,
      minutes_from_sunrise: 30,
      season: 'spring',
    })
    const read = Object.fromEntries(
      DIMENSIONS.filter((d) => d.kind === 'condition').map((d) => [d.id, d.ofHour!(full)]),
    )
    expect(read).toEqual({
      pressure_trend: 'falling',
      sky: 'clear',
      wind: 'light',
      water_temp: '15',
      moon: 'full',
      time_block: 'dawn',
      season: 'spring',
    })
  })

  it('reads the lure dimensions off a catch', () => {
    const lures = DIMENSIONS.filter((d) => d.kind === 'lure')
    expect(lures.map((d) => d.ofCatch!(event))).toEqual(['spinnerbait', 'chartreuse'])
  })

  it('treats an absent or empty pass-through value as no reading at all', () => {
    const pressure = DIMENSIONS.find((d) => d.id === 'pressure_trend')!
    expect(pressure.ofHour!(hour({ pressure_trend: null }))).toBeNull()
    expect(pressure.ofHour!(hour({ pressure_trend: '' }))).toBeNull()
    const color = DIMENSIONS.find((d) => d.id === 'lure_color')!
    expect(color.ofCatch!({ ...event, lure_color: null })).toBeNull()
    expect(color.ofCatch!({ ...event, lure_color: '' })).toBeNull()
  })
})
