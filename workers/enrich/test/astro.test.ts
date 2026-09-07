import { describe, expect, it } from 'vitest'
import { minutesFromSunrise, moonPhaseAt } from '../src/lib/astro'

// Published-ephemeris fixtures (packet §10 acceptance criterion: "astro matches published
// ephemeris for 20 test dates"), sourced from the US Naval Observatory API
// (aa.usno.navy.mil/api) on 2026-09-07.

// Moon phases: 20 consecutive named phase events for Jan-May 2026 (UTC), each with its expected
// point on the 0..1 cycle (0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter).
const MOON_PHASE_TOLERANCE = 0.03 // ~21h — suncalc's low-precision algorithm vs. USNO's high-precision ephemeris
const MOON_EVENTS: { utc: number; expected: number; label: string }[] = [
  { utc: Date.UTC(2026, 0, 3, 10, 3), expected: 0.5, label: 'Full Moon 2026-01-03' },
  { utc: Date.UTC(2026, 0, 10, 15, 48), expected: 0.75, label: 'Last Quarter 2026-01-10' },
  { utc: Date.UTC(2026, 0, 18, 19, 52), expected: 0, label: 'New Moon 2026-01-18' },
  { utc: Date.UTC(2026, 0, 26, 4, 47), expected: 0.25, label: 'First Quarter 2026-01-26' },
  { utc: Date.UTC(2026, 1, 1, 22, 9), expected: 0.5, label: 'Full Moon 2026-02-01' },
  { utc: Date.UTC(2026, 1, 9, 12, 43), expected: 0.75, label: 'Last Quarter 2026-02-09' },
  { utc: Date.UTC(2026, 1, 17, 12, 1), expected: 0, label: 'New Moon 2026-02-17' },
  { utc: Date.UTC(2026, 1, 24, 12, 27), expected: 0.25, label: 'First Quarter 2026-02-24' },
  { utc: Date.UTC(2026, 2, 3, 11, 38), expected: 0.5, label: 'Full Moon 2026-03-03' },
  { utc: Date.UTC(2026, 2, 11, 9, 38), expected: 0.75, label: 'Last Quarter 2026-03-11' },
  { utc: Date.UTC(2026, 2, 19, 1, 23), expected: 0, label: 'New Moon 2026-03-19' },
  { utc: Date.UTC(2026, 2, 25, 19, 18), expected: 0.25, label: 'First Quarter 2026-03-25' },
  { utc: Date.UTC(2026, 3, 2, 2, 12), expected: 0.5, label: 'Full Moon 2026-04-02' },
  { utc: Date.UTC(2026, 3, 10, 4, 51), expected: 0.75, label: 'Last Quarter 2026-04-10' },
  { utc: Date.UTC(2026, 3, 17, 11, 52), expected: 0, label: 'New Moon 2026-04-17' },
  { utc: Date.UTC(2026, 3, 24, 2, 32), expected: 0.25, label: 'First Quarter 2026-04-24' },
  { utc: Date.UTC(2026, 4, 1, 17, 23), expected: 0.5, label: 'Full Moon 2026-05-01' },
  { utc: Date.UTC(2026, 4, 9, 21, 10), expected: 0.75, label: 'Last Quarter 2026-05-09' },
  { utc: Date.UTC(2026, 4, 16, 20, 1), expected: 0, label: 'New Moon 2026-05-16' },
  { utc: Date.UTC(2026, 4, 23, 11, 11), expected: 0.25, label: 'First Quarter 2026-05-23' },
]

function circularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b)
  return Math.min(diff, 1 - diff)
}

describe('moonPhaseAt', () => {
  it.each(MOON_EVENTS)('matches USNO ephemeris: $label', ({ utc, expected }) => {
    const phase = moonPhaseAt(new Date(utc))
    expect(circularDistance(phase, expected)).toBeLessThanOrEqual(MOON_PHASE_TOLERANCE)
  })
})

// Sunrise: published USNO sunrise times for Nashville, TN (36.1627, -86.7816), spread across the
// year (local times converted to UTC using that date's actual DST offset).
const NASHVILLE = { lat: 36.1627, lng: -86.7816 }
const SUNRISE_TOLERANCE_MIN = 3
const SUNRISE_EVENTS: { utc: number; label: string }[] = [
  { utc: Date.UTC(2026, 0, 15, 12, 57), label: '2026-01-15 (CST, sunrise 06:57 local)' },
  { utc: Date.UTC(2026, 2, 15, 11, 58), label: '2026-03-15 (CDT, sunrise 06:58 local)' },
  { utc: Date.UTC(2026, 4, 15, 10, 41), label: '2026-05-15 (CDT, sunrise 05:41 local)' },
  { utc: Date.UTC(2026, 5, 21, 10, 30), label: '2026-06-21 (CDT, sunrise 05:30 local)' },
  { utc: Date.UTC(2026, 7, 15, 11, 5), label: '2026-08-15 (CDT, sunrise 06:05 local)' },
  { utc: Date.UTC(2026, 9, 15, 11, 54), label: '2026-10-15 (CDT, sunrise 06:54 local)' },
  { utc: Date.UTC(2026, 11, 15, 12, 51), label: '2026-12-15 (CST, sunrise 06:51 local)' },
]

describe('minutesFromSunrise', () => {
  it('uses the same sunrise for midnight and noon of a local solar day', () => {
    const midnight = Date.UTC(2026, 5, 21, 6)
    const noon = midnight + 12 * 60 * 60_000
    expect(minutesFromSunrise(noon, NASHVILLE.lat, NASHVILLE.lng)! - minutesFromSunrise(midnight, NASHVILLE.lat, NASHVILLE.lng)!).toBe(720)
  })

  it('returns null during polar day or polar night', () => {
    expect(minutesFromSunrise(Date.UTC(2026, 5, 21, 12), 89, 0)).toBeNull()
    expect(minutesFromSunrise(Date.UTC(2026, 11, 21, 12), 89, 0)).toBeNull()
  })

  it.each(SUNRISE_EVENTS)('matches USNO ephemeris within $SUNRISE_TOLERANCE_MIN min: $label', ({ utc }) => {
    // Evaluated at the published sunrise instant itself: minutesFromSunrise should read ~0.
    const minutes = minutesFromSunrise(utc, NASHVILLE.lat, NASHVILLE.lng)
    expect(minutes).not.toBeNull()
    expect(Math.abs(minutes!)).toBeLessThanOrEqual(SUNRISE_TOLERANCE_MIN)
  })

  it('is negative before sunrise and positive after', () => {
    const sunrise = Date.UTC(2026, 5, 21, 10, 30)
    expect(minutesFromSunrise(sunrise - 30 * 60_000, NASHVILLE.lat, NASHVILLE.lng)).toBeLessThan(0)
    expect(minutesFromSunrise(sunrise + 30 * 60_000, NASHVILLE.lat, NASHVILLE.lng)).toBeGreaterThan(0)
  })
})
