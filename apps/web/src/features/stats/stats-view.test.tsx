// @vitest-environment jsdom
import type { Stats } from '@waterlog/schema'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatsView } from './stats-view'

function stats(overrides: Partial<Stats> = {}): Stats {
  return {
    totals: { catches: 12, trips: 4, hours_on_water: 10.5, skunked_trips: 1, species: 3, waters: 2 },
    by_species: [
      { species: 'largemouth_bass', catches: 7 },
      { species: 'bluegill', catches: 3 },
      { species: 'channel_catfish', catches: 2 },
    ],
    by_month: [
      { month: '2026-07', catches: 5, trips: 2 },
      { month: '2026-06', catches: 7, trips: 2 },
    ],
    by_water: [
      { water_body_id: 'wb_norris', water_body_name: 'Norris Lake', catches: 9, trips: 3 },
      { water_body_id: null, water_body_name: null, catches: 3, trips: 1 },
    ],
    ...overrides,
  }
}

function mockStats(body: Stats | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!body) throw new Error('offline')
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('StatsView (F4 free tier)', () => {
  it('gives every number a plain-English sentence, skunks included', async () => {
    mockStats(stats())
    render(<StatsView />)

    expect(
      await screen.findByText('12 catches across 4 trips, 1 of them without a fish — 1.14 fish per hour on the water.'),
    ).toBeInTheDocument()
  })

  it('shows the totals and the three breakdowns', async () => {
    mockStats(stats())
    render(<StatsView />)

    // Totals strip: catches, trips, hours, species.
    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.getByText('10.5')).toBeInTheDocument()

    const bySpecies = screen.getByRole('heading', { name: 'By species' }).parentElement!
    expect(within(bySpecies).getByText('Largemouth Bass')).toBeInTheDocument()
    expect(within(bySpecies).getByText('7')).toBeInTheDocument()

    const byMonth = screen.getByRole('heading', { name: 'By month' }).parentElement!
    expect(within(byMonth).getByText('Jul 2026')).toBeInTheDocument()

    const byWater = screen.getByRole('heading', { name: 'By water' }).parentElement!
    expect(within(byWater).getByText('Norris Lake')).toBeInTheDocument()
    // A trip with no water is still a trip; it gets its own row rather than vanishing.
    expect(within(byWater).getByText('No water recorded')).toBeInTheDocument()
  })

  it('reads as an invitation, not an error, before anything is logged', async () => {
    mockStats(
      stats({
        totals: { catches: 0, trips: 0, hours_on_water: 0, skunked_trips: 0, species: 0, waters: 0 },
        by_species: [],
        by_month: [],
        by_water: [],
      }),
    )
    render(<StatsView />)

    expect(await screen.findByText('Nothing logged yet — your first trip starts the record.')).toBeInTheDocument()
    expect(screen.getByText('No catches yet.')).toBeInTheDocument()
  })

  it('counts trips that caught nothing, without dividing by zero hours', async () => {
    mockStats(
      stats({
        totals: { catches: 0, trips: 2, hours_on_water: 0, skunked_trips: 2, species: 0, waters: 1 },
        by_species: [],
        by_month: [{ month: '2026-06', catches: 0, trips: 2 }],
        by_water: [{ water_body_id: 'wb_norris', water_body_name: 'Norris Lake', catches: 0, trips: 2 }],
      }),
    )
    render(<StatsView />)

    expect(await screen.findByText('2 trips logged, no catches yet.')).toBeInTheDocument()
  })

  it('says so when the server is unreachable', async () => {
    mockStats(null)
    render(<StatsView />)

    expect(await screen.findByText('Offline — stats are computed on the server.')).toBeInTheDocument()
  })
})
