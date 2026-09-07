import { expect, it } from 'vitest'
import { fetchGaugeReading, findNearestGauge } from '../src/lib/usgs'

// Explicit opt-in only: pnpm test:usgs-live. Does not run in normal CI.
// Public reference stations, not a claim of founder-water coverage.
it.each([
  { name: 'Nashville, TN', lat: 36.1627, lng: -86.7816, station: '03431500' },
  { name: 'Columbia, SC', lat: 33.993, lng: -81.05, station: '02169500' },
])(
  'checks modern USGS discovery and historical data: $name',
  async ({ name, lat, lng, station }) => {
    const at = Date.UTC(2026, 8, 6, 12)
    const checkedFetch: typeof fetch = async (input, init) => {
      try {
        const response = await fetch(input, init)
        if (!response.ok)
          console.error('USGS live HTTP failure', response.status, await response.clone().text())
        return response
      } catch (error) {
        console.error('USGS live transport failure', error)
        throw error
      }
    }
    const gauge = await findNearestGauge(checkedFetch, lat, lng, 15, undefined, at)
    expect(gauge).not.toBeNull()
    expect(gauge!.distanceKm).toBeLessThanOrEqual(15)
    const reading = await fetchGaugeReading(checkedFetch, station, at)
    expect(reading).not.toBeNull()
    expect(reading!.dischargeCms).toEqual(expect.any(Number))
    console.info(
      JSON.stringify({
        name,
        gauge,
        referenceStation: station,
        at: new Date(at).toISOString(),
        reading,
      }),
    )
  },
  40_000,
)

it('checks a live historical water-temperature series', async () => {
  const at = Date.UTC(2026, 8, 6, 12)
  const reading = await fetchGaugeReading(fetch, '03431083', at)
  expect(reading?.waterTempC).toEqual(expect.any(Number))
  console.info(
    JSON.stringify({ referenceStation: '03431083', at: new Date(at).toISOString(), reading }),
  )
}, 20_000)
