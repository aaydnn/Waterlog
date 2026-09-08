import { describe, expect, it, vi } from 'vitest'
import { describeGauge, fetchPoolElevation, isGaugeId, isPoolGauge } from '../src/lib/nwps'

const AT = Date.UTC(2026, 8, 7, 23)
const HOUR_MS = 3_600_000

function stageflow(points: { validTime: string; primary: number }[]) {
  return { observed: { primaryName: 'Pool', primaryUnits: 'ft', data: points } }
}

function jsonFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch
}

describe('isGaugeId', () => {
  it('accepts NWPS handles and rejects anything that could reshape the URL', () => {
    expect(isGaugeId('NRST1')).toBe(true)
    expect(isGaugeId('nrtt1')).toBe(true)
    expect(isGaugeId('')).toBe(false)
    expect(isGaugeId('abc')).toBe(false) // too short
    expect(isGaugeId('../../secrets')).toBe(false)
    expect(isGaugeId('NRST1/stageflow')).toBe(false)
  })
})

describe('isPoolGauge', () => {
  it('reads the physical element out of pedts', () => {
    expect(isPoolGauge('HPIRZ')).toBe(true) // pool — a reservoir
    expect(isPoolGauge('HTIRZ')).toBe(false) // tailwater
    expect(isPoolGauge('HGIRG')).toBe(false) // river stage
    expect(isPoolGauge(null)).toBe(false)
    expect(isPoolGauge('H')).toBe(false)
  })
})

describe('fetchPoolElevation', () => {
  it('picks the observation closest to the hour asked about, not the latest', async () => {
    // The newest reading is the wrong answer when enriching a catch from earlier — which is why
    // this uses /stageflow rather than the gauge summary's single current value.
    const body = stageflow([
      { validTime: new Date(AT - 2 * HOUR_MS).toISOString(), primary: 1010.0 },
      { validTime: new Date(AT).toISOString(), primary: 1012.22 },
      { validTime: new Date(AT + 2 * HOUR_MS).toISOString(), primary: 1014.0 },
    ])
    const reading = await fetchPoolElevation(jsonFetch(body), 'NRST1', AT)
    expect(reading?.poolFt).toBe(1012.22)
    expect(reading?.observedAtMs).toBe(AT)
  })

  it('treats the -999 sentinel as missing rather than a real elevation', async () => {
    const body = stageflow([{ validTime: new Date(AT).toISOString(), primary: -999 }])
    const reading = await fetchPoolElevation(jsonFetch(body), 'NRST1', AT)
    expect(reading?.poolFt).toBeNull()
  })

  it('refuses to substitute a distant hour for the one requested', async () => {
    const body = stageflow([{ validTime: new Date(AT - 9 * HOUR_MS).toISOString(), primary: 1012 }])
    expect(await fetchPoolElevation(jsonFetch(body), 'NRST1', AT)).toBeNull()
  })

  it('returns null without fetching for a malformed gauge id', async () => {
    const spy = jsonFetch(stageflow([]))
    expect(await fetchPoolElevation(spy, '../etc', AT)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('is best-effort: a failed, malformed, or empty response never throws', async () => {
    expect(await fetchPoolElevation(jsonFetch(stageflow([]), false), 'NRST1', AT)).toBeNull()
    expect(await fetchPoolElevation(jsonFetch({ nonsense: true }), 'NRST1', AT)).toBeNull()
    expect(await fetchPoolElevation(jsonFetch(stageflow([])), 'NRST1', AT)).toBeNull()
    const throwing = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    expect(await fetchPoolElevation(throwing, 'NRST1', AT)).toBeNull()
  })
})

describe('describeGauge', () => {
  it('reports whether a configured gauge actually measures pool stage', async () => {
    const body = {
      lid: 'NRST1',
      name: 'Clinch River above Norris Dam',
      latitude: 36.2275,
      longitude: -84.093611,
      pedts: { observed: 'HPIRZ', forecast: 'HPIFF' },
    }
    expect(await describeGauge(jsonFetch(body), 'NRST1')).toEqual({
      lid: 'NRST1',
      name: 'Clinch River above Norris Dam',
      isPool: true,
      lat: 36.2275,
      lng: -84.093611,
    })
  })

  it('returns null for a bad id or an unusable response', async () => {
    expect(await describeGauge(jsonFetch({}), 'nope!')).toBeNull()
    expect(await describeGauge(jsonFetch({ lid: 'X' }), 'NRST1')).toBeNull()
  })
})
