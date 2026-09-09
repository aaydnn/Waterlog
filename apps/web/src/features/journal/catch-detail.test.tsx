// @vitest-environment jsdom
import type { CatchDetail as CatchDetailPayload } from '@waterlog/schema'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatchDetail } from './catch-detail'

const CAUGHT_AT = Date.UTC(2026, 6, 4, 12, 0, 0)

function payload(overrides: Partial<CatchDetailPayload> = {}): CatchDetailPayload {
  return {
    catch: {
      id: 'cat_1',
      user_id: 'u1',
      trip_id: 'trp_1',
      lure_id: 'lur_1',
      species: 'largemouth_bass',
      caught_at: CAUGHT_AT,
      lat: 36.2,
      lng: -84.09,
      photo_key: 'photos/u1/fish.jpg',
      length_mm: 470,
      weight_g: 1450,
      depth_m: 2.5,
      released: 1,
      notes: 'Windblown point, slow roll.',
      client_id: 'cc1',
      enrich_status: 'done',
      created_at: CAUGHT_AT,
      updated_at: CAUGHT_AT,
      deleted_at: null,
    },
    trip: null,
    water_body: {
      id: 'wb_norris',
      user_id: 'u1',
      name: 'Norris Lake',
      kind: 'reservoir',
      centroid_lat: 36.3572,
      centroid_lng: -83.6848,
      usgs_gauge_id: null,
      nwps_gauge_id: 'NRST1',
      is_home: 0,
      created_at: 0,
      updated_at: 0,
      deleted_at: null,
    },
    lure: {
      id: 'lur_1',
      user_id: 'u1',
      name: 'War Eagle Spinnerbait',
      family: 'spinnerbait',
      color: 'chartreuse',
      cost_cents: 899,
      retired_at: null,
      created_at: 0,
      updated_at: 0,
      deleted_at: null,
    },
    conditions: {
      id: 'cnd_1',
      user_id: 'u1',
      catch_id: 'cat_1',
      trip_id: null,
      hour_bucket: null,
      air_temp_c: 24.5,
      cloud_pct: 40,
      wind_kph: 16.1,
      precip_mm: 0,
      pressure_hpa: 1013.25,
      pressure_trend: 'falling',
      moon_phase: 0.5,
      minutes_from_sunrise: 72,
      water_temp_c: 21.1,
      water_temp_source: 'measured',
      discharge_cms: null,
      pool_elevation_ft: 1018.4,
      tailwater_ft: null,
      season: 'summer',
      source_meta: null,
      created_at: CAUGHT_AT,
    },
    ...overrides,
  }
}

function mockDetail(body: CatchDetailPayload | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!body) throw new Error('offline')
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('CatchDetail (F3 detail)', () => {
  it('shows the fish, where it came from, and every enriched condition in angler units', async () => {
    mockDetail(payload())
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)

    expect(await screen.findByRole('heading', { name: 'Largemouth Bass' })).toBeInTheDocument()
    expect(screen.getByText('18.5 in · 3 lb 3 oz · 8.2 ft')).toBeInTheDocument()
    expect(screen.getByText('Norris Lake · War Eagle Spinnerbait')).toBeInTheDocument()
    expect(screen.getByText('Windblown point, slow roll.')).toBeInTheDocument()

    expect(screen.getByText('76°F')).toBeInTheDocument() // air
    expect(screen.getByText('70°F (measured)')).toBeInTheDocument() // water, with its provenance
    expect(screen.getByText('10 mph')).toBeInTheDocument()
    expect(screen.getByText('29.92 inHg · falling')).toBeInTheDocument()
    expect(screen.getByText('Full moon')).toBeInTheDocument()
    expect(screen.getByText('1h 12m after sunrise')).toBeInTheDocument()
    expect(screen.getByText('1018.4 ft')).toBeInTheDocument() // NWPS pool elevation
  })

  it('omits readings the water does not have, rather than showing them as zero', async () => {
    mockDetail(payload())
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)

    await screen.findByRole('heading', { name: 'Largemouth Bass' })
    // Norris has no USGS discharge and no tailwater reading (ADR-0008).
    expect(screen.queryByText('Flow')).not.toBeInTheDocument()
    expect(screen.queryByText('Tailwater')).not.toBeInTheDocument()
  })

  it('says enrichment is still running when there is no conditions row yet', async () => {
    mockDetail(payload({ conditions: null, catch: { ...payload().catch, enrich_status: 'pending' } }))
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)

    expect(await screen.findByText('Enriching conditions…')).toBeInTheDocument()
  })

  it('explains itself when offline instead of showing an empty sheet', async () => {
    mockDetail(null)
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)

    expect(await screen.findByText(/Offline — the full conditions/)).toBeInTheDocument()
  })

  it('closes on the close button', async () => {
    mockDetail(payload())
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<CatchDetail catchId="cat_1" onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Close catch detail' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('CatchDetail partial state (T3.1)', () => {
  function withSources(status: 'done' | 'partial' | 'failed', sources: Record<string, unknown>) {
    const base = payload()
    return {
      ...base,
      catch: { ...base.catch, enrich_status: status },
      conditions: { ...base.conditions!, source_meta: JSON.stringify(sources) },
    }
  }

  it('says nothing when everything was fetched', async () => {
    mockDetail(withSources('done', { weather: true, pool: true, water_temp: 'measured' }))
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)

    await screen.findByRole('heading', { name: 'Largemouth Bass' })
    expect(screen.queryByText(/Couldn't reach/)).not.toBeInTheDocument()
    expect(screen.queryByText(/No gauge covers/)).not.toBeInTheDocument()
  })

  it('distinguishes a source that failed from one that does not exist', async () => {
    // A gauge that exists and failed: retryable, and the panel should promise it will fill in.
    mockDetail(withSources('partial', { weather: true, gauge: false }))
    const { unmount } = render(<CatchDetail catchId="cat_1" onClose={() => {}} />)
    expect(await screen.findByText(/Couldn't reach river level/)).toBeInTheDocument()
    unmount()

    // No gauge in range is permanent (ADR-0008) and is not a failure — Lake Oliphant will never
    // have one, and telling the angler to wait for it would be a lie.
    mockDetail(withSources('done', { weather: true, gauge: 'none-in-range' }))
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)
    expect(await screen.findByText(/No gauge covers this water/)).toBeInTheDocument()
    expect(screen.queryByText(/Couldn't reach/)).not.toBeInTheDocument()
  })

  it('names every source that is missing, not just the first', async () => {
    mockDetail(withSources('partial', { weather: false, pool: false }))
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)

    expect(await screen.findByText(/Couldn't reach weather and lake level/)).toBeInTheDocument()
  })

  it('reports an outright failure as one', async () => {
    mockDetail(withSources('failed', {}))
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)

    expect(await screen.findByText('Conditions could not be fetched for this catch.')).toBeInTheDocument()
  })

  it('still shows the readings it did get alongside the note', async () => {
    mockDetail(withSources('partial', { weather: true, gauge: false }))
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)

    await screen.findByText(/Couldn't reach river level/)
    // Partial is not empty: the weather it did fetch is still worth showing.
    expect(screen.getByText('76°F')).toBeInTheDocument()
  })

  it('survives source_meta it cannot parse rather than blanking the panel', async () => {
    const base = payload()
    mockDetail({ ...base, conditions: { ...base.conditions!, source_meta: 'not json{' } })
    render(<CatchDetail catchId="cat_1" onClose={() => {}} />)

    expect(await screen.findByText('76°F')).toBeInTheDocument()
  })
})
