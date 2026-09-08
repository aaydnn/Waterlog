import { describe, expect, it } from 'vitest'
import type { HourlyWeatherPoint } from '../src/lib/open-meteo'
import { estimateWaterTempC, WINDOW_HOURS } from '../src/lib/water-temp'

const HOUR_MS = 3_600_000
const AT = Date.UTC(2026, 5, 1, 12)

function point(timeMs: number, airTempC: number | null): HourlyWeatherPoint {
  return { timeMs, airTempC, cloudPct: 0, windKph: 0, precipMm: 0, pressureHpa: 1013 }
}

/** Hours back from AT, newest first, each with the given air temperature. */
function series(temps: (number | null)[]): HourlyWeatherPoint[] {
  return temps.map((airTempC, i) => point(AT - i * HOUR_MS, airTempC))
}

describe('estimateWaterTempC', () => {
  it('returns the steady air temperature when nothing has changed', () => {
    expect(estimateWaterTempC(series(Array(72).fill(18)), AT)).toBe(18)
  })

  it('lags a sudden warm spell instead of tracking it', () => {
    // 30C for the last 12 hours, 10C for the several days before that. Water should sit well
    // below the current air temperature, because it carries the cold history with it.
    const temps = [...Array(12).fill(30), ...Array(150).fill(10)]
    const estimate = estimateWaterTempC(series(temps), AT)!
    expect(estimate).toBeGreaterThan(10)
    expect(estimate).toBeLessThan(30)
    // Nearer the multi-day history than the last few hours: that is the thermal mass.
    expect(estimate).toBeLessThan(20)
  })

  it('damps the diurnal swing rather than following it', () => {
    // A day/night cycle averaging 20C. The estimate should sit near the mean, not the peak.
    const cycle = Array.from({ length: 168 }, (_, i) => 20 + 10 * Math.sin((i / 24) * 2 * Math.PI))
    const estimate = estimateWaterTempC(series(cycle), AT)!
    expect(estimate).toBeGreaterThan(17)
    expect(estimate).toBeLessThan(23)
  })

  it('ignores hours outside the window and hours in the future', () => {
    const stale = point(AT - (WINDOW_HOURS + 50) * HOUR_MS, -40)
    const future = point(AT + 10 * HOUR_MS, 99)
    const estimate = estimateWaterTempC([...series(Array(24).fill(15)), stale, future], AT)
    expect(estimate).toBe(15)
  })

  it('never reports a sub-freezing surface', () => {
    // Ice cover decouples the surface from the air; -20C air does not mean -20C water.
    expect(estimateWaterTempC(series(Array(72).fill(-20)), AT)).toBe(0)
  })

  it('returns null when there is nothing usable to average', () => {
    expect(estimateWaterTempC([], AT)).toBeNull()
    expect(estimateWaterTempC(series([null, null, null]), AT)).toBeNull()
    expect(estimateWaterTempC(series([15]), Number.NaN)).toBeNull()
  })
})
