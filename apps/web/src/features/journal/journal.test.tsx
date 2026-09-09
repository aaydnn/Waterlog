// @vitest-environment jsdom
import type { JournalEntry } from '@waterlog/schema'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WaterlogDb } from '../../lib/db'
import { Journal } from './journal'

let dbCounter = 0
function freshDb(): WaterlogDb {
  dbCounter += 1
  return new WaterlogDb(`test-journal-${dbCounter}`)
}

const JULY_4 = Date.UTC(2026, 6, 4, 12, 0, 0)

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'cat_1',
    caught_at: JULY_4,
    species: 'largemouth_bass',
    photo_key: null,
    length_mm: 470,
    weight_g: 1450,
    released: 1,
    notes: null,
    enrich_status: 'done',
    lure_id: 'lur_1',
    lure_name: 'War Eagle Spinnerbait',
    trip_id: 'trp_1',
    water_body_id: 'wb_norris',
    water_body_name: 'Norris Lake',
    ...overrides,
  }
}

/** Captures the journal query the component actually sent, so filter tests assert on the wire
 * rather than on what happens to render. */
function mockJournal(pages: Array<{ entries: JournalEntry[]; next_cursor: string | null }>) {
  const urls: string[] = []
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/api/journal')) {
        const page = pages[Math.min(call, pages.length - 1)]!
        call += 1
        return { ok: true, status: 200, json: async () => page }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return urls
}

afterEach(() => vi.unstubAllGlobals())

describe('Journal (F3)', () => {
  it('renders catches newest-first with the lure, water and measurements on the card', async () => {
    mockJournal([{ entries: [entry(), entry({ id: 'cat_2', species: 'bluegill', caught_at: JULY_4 - 3600_000 })], next_cursor: null }])
    render(<Journal db={freshDb()} />)

    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]!).getByText('Largemouth Bass')).toBeInTheDocument()
    expect(within(items[0]!).getByText(/Norris Lake · War Eagle Spinnerbait · 18.5 in · 3 lb 3 oz/)).toBeInTheDocument()
    expect(within(items[1]!).getByText('Bluegill')).toBeInTheDocument()
  })

  it('shows the packet empty state before the first catch', async () => {
    mockJournal([{ entries: [], next_cursor: null }])
    render(<Journal db={freshDb()} />)

    expect(
      await screen.findByText('Your first catch starts your dataset. Everything else is automatic.'),
    ).toBeInTheDocument()
  })

  it('sends the chosen filters to the server', async () => {
    const urls = mockJournal([{ entries: [entry()], next_cursor: null }])
    const db = freshDb()
    await db.waterBodies.put({
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
    })
    const user = userEvent.setup()
    render(<Journal db={db} />)

    await screen.findAllByRole('listitem')
    await user.selectOptions(screen.getByLabelText('Filter by species'), 'bluegill')
    await waitFor(() => expect(urls.at(-1)).toContain('species=bluegill'))

    await user.selectOptions(screen.getByLabelText('Filter by water'), 'wb_norris')
    await waitFor(() => expect(urls.at(-1)).toContain('water_body_id=wb_norris'))
  })

  it('turns a date range into inclusive whole-day bounds', async () => {
    const urls = mockJournal([{ entries: [], next_cursor: null }])
    const user = userEvent.setup()
    render(<Journal db={freshDb()} />)

    await screen.findByText(/Your first catch starts your dataset/)
    await user.type(screen.getByLabelText('From date'), '2026-07-04')
    await user.type(screen.getByLabelText('To date'), '2026-07-04')

    await waitFor(() => {
      const last = new URL(`http://x${urls.at(-1)!}`)
      const from = Number(last.searchParams.get('from'))
      const to = Number(last.searchParams.get('to'))
      // A single-day range covers that whole local day, not one instant of it.
      expect(to - from).toBe(24 * 60 * 60 * 1000 - 1)
      expect(new Date(from).getHours()).toBe(0)
    })
  })

  it('pages with the cursor the server returned', async () => {
    mockJournal([
      { entries: [entry({ id: 'cat_1' })], next_cursor: `${JULY_4}.cat_1` },
      { entries: [entry({ id: 'cat_2', species: 'bluegill' })], next_cursor: null },
    ])
    const user = userEvent.setup()
    render(<Journal db={freshDb()} />)

    await screen.findAllByRole('listitem')
    await user.click(screen.getByRole('button', { name: 'Load more' }))

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2))
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('falls back to the catches on this device when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const db = freshDb()
    await db.trips.put({
      local_id: 'trp_local',
      client_id: 'tc1',
      id: null,
      water_body_id: 'wb_norris',
      water_temp_c: null,
      started_at: JULY_4 - 3600_000,
      ended_at: null,
      auto_created: 0,
      planned: 0,
      notes: null,
      synced_at: null,
    })
    await db.waterBodies.put({
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
    })
    await db.catches.put({
      local_id: 'cat_local',
      client_id: 'cc1',
      id: null,
      trip_id: 'trp_local',
      lure_id: null,
      species: 'black_crappie',
      caught_at: JULY_4,
      lat: null,
      lng: null,
      photo_key: null,
      length_mm: null,
      weight_g: null,
      depth_m: null,
      released: null,
      notes: null,
      synced_at: null,
    })

    render(<Journal db={db} />)

    expect(await screen.findByText(/Offline — showing what/)).toBeInTheDocument()
    // Scoped to the card: the filter selects carry these same names as option text.
    const card = (await screen.findAllByRole('listitem'))[0]!
    expect(within(card).getByText('Black Crappie')).toBeInTheDocument()
    // The unsynced catch resolves its water through the local trip, not the server.
    expect(within(card).getByText(/Norris Lake/)).toBeInTheDocument()
  })
})
