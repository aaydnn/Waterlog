import { describe, expect, it, vi } from 'vitest'
import { fetchHourlyWeather, nearestPoint } from '../src/lib/open-meteo'

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}

describe('fetchHourlyWeather', () => {
  it('parses the hourly series into aligned points', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        hourly: {
          time: ['2026-06-01T10:00', '2026-06-01T11:00'],
          temperature_2m: [22.5, 23.1],
          cloud_cover: [40, 45],
          wind_speed_10m: [12, 14],
          precipitation: [0, 0.2],
          surface_pressure: [1016.2, 1015.9],
        },
      }),
    )

    const points = await fetchHourlyWeather(fetchFn, 36.16, -86.78, Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 1, 12))
    expect(points).toEqual([
      { timeMs: Date.UTC(2026, 5, 1, 10), airTempC: 22.5, cloudPct: 40, windKph: 12, precipMm: 0, pressureHpa: 1016.2 },
      { timeMs: Date.UTC(2026, 5, 1, 11), airTempC: 23.1, cloudPct: 45, windKph: 14, precipMm: 0.2, pressureHpa: 1015.9 },
    ])
  })

  it('uses the forecast API for a recent window', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ hourly: { time: [] } }))
    await fetchHourlyWeather(fetchFn, 36.16, -86.78, Date.now() - 3_600_000, Date.now())
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('api.open-meteo.com/v1/forecast'))
  })

  it('uses the historical archive API for an old window', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ hourly: { time: [] } }))
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000
    await fetchHourlyWeather(fetchFn, 36.16, -86.78, old, old + 3_600_000)
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('archive-api.open-meteo.com/v1/archive'))
  })

  it('returns null on a non-ok response, never throwing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false))
    expect(await fetchHourlyWeather(fetchFn, 36.16, -86.78, 0, 3_600_000)).toBeNull()
  })

  it('returns null when the response has no hourly series', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}))
    expect(await fetchHourlyWeather(fetchFn, 36.16, -86.78, 0, 3_600_000)).toBeNull()
  })

  it('returns null on a network error, never throwing', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'))
    expect(await fetchHourlyWeather(fetchFn, 36.16, -86.78, 0, 3_600_000)).toBeNull()
  })
})

describe('nearestPoint', () => {
  const points = [
    { timeMs: 1000, airTempC: 1, cloudPct: null, windKph: null, precipMm: null, pressureHpa: null },
    { timeMs: 5000, airTempC: 2, cloudPct: null, windKph: null, precipMm: null, pressureHpa: null },
    { timeMs: 9000, airTempC: 3, cloudPct: null, windKph: null, precipMm: null, pressureHpa: null },
  ]

  it('picks the closest point by time', () => {
    expect(nearestPoint(points, 6000)!.airTempC).toBe(2)
    expect(nearestPoint(points, 8000)!.airTempC).toBe(3)
  })

  it('returns null for an empty series', () => {
    expect(nearestPoint([], 1000)).toBeNull()
  })

  it('does not substitute a distant point for a missing six-hour pressure reading', () => {
    expect(nearestPoint(points, 6 * 3_600_000)).toBeNull()
  })
})
