import { describe, expect, it } from 'vitest'
import {
  formatDepth,
  formatFromSunrise,
  formatLength,
  formatMoonPhase,
  formatPressure,
  formatTemp,
  formatWeight,
  formatWind,
} from './units'

describe('imperial display', () => {
  it('formats a fish the way an angler says it', () => {
    expect(formatLength(470)).toBe('18.5 in')
    expect(formatWeight(1450)).toBe('3 lb 3 oz')
    // Under a pound, "0 lb 9 oz" is how nobody talks.
    expect(formatWeight(250)).toBe('9 oz')
  })

  it('formats conditions', () => {
    expect(formatTemp(21.1)).toBe('70°F')
    expect(formatWind(16.1)).toBe('10 mph')
    expect(formatPressure(1013.25)).toBe('29.92 inHg')
    expect(formatDepth(2.5)).toBe('8.2 ft')
  })

  it('passes null through, so an absent reading renders as absent rather than as zero', () => {
    expect(formatLength(null)).toBeNull()
    expect(formatWeight(null)).toBeNull()
    expect(formatTemp(null)).toBeNull()
    expect(formatWind(null)).toBeNull()
    expect(formatPressure(null)).toBeNull()
    expect(formatDepth(null)).toBeNull()
    expect(formatMoonPhase(null)).toBeNull()
    expect(formatFromSunrise(null)).toBeNull()
  })

  it('names the moon phase instead of printing a decimal', () => {
    expect(formatMoonPhase(0)).toBe('New moon')
    expect(formatMoonPhase(0.25)).toBe('First quarter')
    expect(formatMoonPhase(0.5)).toBe('Full moon')
    expect(formatMoonPhase(0.75)).toBe('Last quarter')
    // 1.0 is new again, not a ninth phase.
    expect(formatMoonPhase(1)).toBe('New moon')
  })

  it('frames the clock around sunrise', () => {
    expect(formatFromSunrise(0)).toBe('At sunrise')
    expect(formatFromSunrise(35)).toBe('35m after sunrise')
    expect(formatFromSunrise(-35)).toBe('35m before sunrise')
    expect(formatFromSunrise(72)).toBe('1h 12m after sunrise')
    expect(formatFromSunrise(-90)).toBe('1h 30m before sunrise')
  })
})
