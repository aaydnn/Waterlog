import { describe, expect, it, vi } from 'vitest'
import { fetchGaugeReading, findNearestGauge } from '../src/lib/usgs'
import { readingFeature, seriesFeature, usgsPage } from './usgs-fixtures'

const AT = Date.UTC(2026, 5, 1, 12)
const API = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections/'
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}
const find = (fetchFn: typeof fetch) =>
  findNearestGauge(fetchFn, 36.1627, -86.7816, 15, undefined, AT)

describe('findNearestGauge: modern metadata', () => {
  it('selects the nearest eligible station, including a station on a later page', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          usgsPage(
            [seriesFeature('USGS-03431500', -86.7, 36.1)],
            `${API}time-series-metadata/items?cursor=next`,
          ),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(usgsPage([seriesFeature()])))
    expect((await find(fetchFn))!.siteId).toBe('USGS-03431600')
    const query = new URL(fetchFn.mock.calls[0]![0])
    expect(query.pathname).toContain('/time-series-metadata/items')
    expect(query.searchParams.get('bbox')).toBeTruthy()
    expect(query.searchParams.get('filter')).toContain("parameter_code IN ('00010','00060')")
    expect(query.searchParams.get('filter')).toContain("computation_identifier = 'Instantaneous'")
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('ignores unrelated parameters, daily series, retired records and malformed coordinates', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          usgsPage([
            seriesFeature('USGS-1', -86.7816, 36.1627, { parameter_code: '00065' }),
            seriesFeature('USGS-2', -86.7816, 36.1627, { computation_identifier: 'Mean' }),
            seriesFeature('USGS-3', -86.7816, 36.1627, { end_utc: '1975-01-01T00:00:00Z' }),
            seriesFeature('USGS-4', -86.7816, 36.1627, { begin_utc: '2027-01-01T00:00:00Z' }),
            seriesFeature('USGS-5', -86.7816, 100),
            seriesFeature(),
          ]),
        ),
      )
    expect((await find(fetchFn))!.siteId).toBe('USGS-03431600')
  })

  it('can discover a historical station for a historical catch', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          usgsPage([
            seriesFeature('USGS-03431600', -86.785, 36.165, {
              begin_utc: '1975-01-01T00:00:00Z',
              end_utc: '1975-03-12T00:00:00Z',
            }),
          ]),
        ),
      )
    expect(await find(fetchFn)).toBeNull()
    expect(
      (await findNearestGauge(fetchFn, 36.1627, -86.7816, 15, undefined, Date.UTC(1975, 2, 1)))!
        .siteId,
    ).toBe('USGS-03431600')
  })

  it('returns null outside the 15km circle even inside the bounding box', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(usgsPage([seriesFeature('USGS-1', -86.62, 36.29)])))
    expect(await find(fetchFn)).toBeNull()
  })

  it('rejects invalid input without making requests', async () => {
    const fetchFn = vi.fn()
    expect(await findNearestGauge(fetchFn, NaN, 0)).toBeNull()
    expect(await findNearestGauge(fetchFn, 91, 0)).toBeNull()
    expect(await findNearestGauge(fetchFn, 36, -86, 16)).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('fetchGaugeReading: modern continuous observations', () => {
  it.each(['03431600', 'USGS-03431600'])(
    'normalizes cached ID %s and retrieves historical observations in metric units',
    async (siteId) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            usgsPage([readingFeature('00010', '18.5', AT), readingFeature('00060', '100', AT)]),
          ),
        )
      expect(await fetchGaugeReading(fetchFn, siteId, AT)).toEqual({
        waterTempC: 18.5,
        dischargeCms: 2.83168,
      })
      const query = new URL(fetchFn.mock.calls[0]![0])
      expect(query.pathname).toContain('/continuous/items')
      expect(query.searchParams.get('monitoring_location_id')).toBe('USGS-03431600')
      expect(query.searchParams.get('datetime')).toBe(
        '2026-06-01T09:00:00.000Z/2026-06-01T15:00:00.000Z',
      )
    },
  )

  it('chooses closest valid readings across pages and honors offset timestamps', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          usgsPage(
            [readingFeature('00010', '19', AT - 60_000)],
            `${API}continuous/items?cursor=next`,
          ),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          usgsPage([readingFeature('00010', '18', AT, { time: '2026-06-01T08:00:00-04:00' })]),
        ),
      )
    expect(await fetchGaugeReading(fetchFn, '03431600', AT)).toEqual({
      waterTempC: 18,
      dischargeCms: null,
    })
  })

  it('ignores null, blank, sentinel, nonnumeric, stale, invalid and wrong-station readings', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          usgsPage([
            ...[null, '', ' ', '-999999', 'Ice', 'NaN', 'Infinity'].map((value) =>
              readingFeature('00010', value, AT),
            ),
            readingFeature('00010', '20', AT, { time: 'invalid' }),
            readingFeature('00010', '20', AT - 86_400_000),
            readingFeature('00010', '20', AT, { monitoring_location_id: 'USGS-99999999' }),
          ]),
        ),
      )
    expect(await fetchGaugeReading(fetchFn, '03431600', AT)).toBeNull()
  })

  it('requires known units and does not double-convert metric discharge', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          usgsPage([
            readingFeature('00010', '70', AT, { unit_of_measure: 'degF' }),
            readingFeature('00060', '42', AT, { unit_of_measure: 'unknown' }),
            readingFeature('00060', '2.5', AT, { unit_of_measure: 'm^3/s' }),
          ]),
        ),
      )
    expect(await fetchGaugeReading(fetchFn, '03431600', AT)).toEqual({
      waterTempC: null,
      dischargeCms: 2.5,
    })
  })

  it('produces the same result regardless of observation order', async () => {
    const readings = [
      readingFeature('00010', '19', AT),
      readingFeature('00010', '18', AT, { approval_status: 'Approved' }),
    ]
    for (const rows of [readings, [...readings].reverse()]) {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(usgsPage(rows)))
      expect((await fetchGaugeReading(fetchFn, '03431600', AT))!.waterTempC).toBe(18)
    }
  })
})

describe('USGS request resilience and credentials', () => {
  it('does not follow a redirect response', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://example.com/' } }),
      )
    expect(await fetchGaugeReading(fetchFn, '03431600', AT, 'test-key')).toBeNull()
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('caps pagination instead of caching a result from a truncated search', async () => {
    let page = 0
    const fetchFn = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse(usgsPage([seriesFeature()], `?cursor=${++page}`)),
      )
    expect(await find(fetchFn)).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(10)
  })

  it('sends the key in a header only, on every page, with a timeout and redirects disabled', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(usgsPage([], '?cursor=next')))
      .mockResolvedValueOnce(jsonResponse(usgsPage()))
    await fetchGaugeReading(fetchFn, '03431600', AT, 'test-key')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchFn.mock.calls) {
      expect(url).not.toContain('test-key')
      expect(init).toMatchObject({ headers: { 'X-Api-Key': 'test-key' }, redirect: 'manual' })
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it.each([
    'https://example.com/steal',
    `${API}monitoring-locations/items`,
    `${API}continuous/items?f=json&limit=1000&monitoring_location_id=USGS-03431600`,
  ])('fails safely on an unexpected next link: %s', async (next) => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(usgsPage([], next)))
    expect(await fetchGaugeReading(fetchFn, '03431600', AT, 'test-key')).toBeNull()
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('returns null rather than choosing from incomplete pages on a rate limit', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(usgsPage([seriesFeature()], '?cursor=next')))
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, false))
    expect(await find(fetchFn)).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it.each([{}, { type: 'FeatureCollection', features: null }, { value: { timeSeries: [] } }])(
    'rejects malformed/legacy response %j',
    async (body) => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(body))
      expect(await find(fetchFn)).toBeNull()
      expect(await fetchGaugeReading(fetchFn, '03431600', AT)).toBeNull()
    },
  )

  it('returns null for empty results or a network failure', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(usgsPage()))
    expect(await find(fetchFn)).toBeNull()
    expect(await fetchGaugeReading(fetchFn, '03431600', AT)).toBeNull()
    fetchFn.mockRejectedValue(new Error('network down'))
    expect(await find(fetchFn)).toBeNull()
    expect(await fetchGaugeReading(fetchFn, '03431600', AT)).toBeNull()
  })
})
