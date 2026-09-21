// @vitest-environment jsdom
import type { PatternCard, PatternFeed, PatternTeaser } from '@waterlog/schema'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PatternsView } from './patterns-view'

let cardSeq = 0

function card(overrides: Partial<PatternCard> = {}): PatternCard {
  cardSeq += 1
  return {
    id: `p${cardSeq}`,
    scope: 'all',
    scope_name: null,
    dimension: 'lure_color',
    bucket: 'chartreuse',
    catches: 11,
    hours: 14,
    rate: 0.7857,
    baseline_rate: 0.2455,
    multiplier: 3.2,
    confidence: 'solid',
    trips: 6,
    computed_at: 1_789_000_000_000,
    ...overrides,
  }
}

function teaser(overrides: Partial<PatternTeaser> = {}): PatternTeaser {
  cardSeq += 1
  return { id: `t${cardSeq}`, dimension_label: 'your lure colour', confidence: 'promising', ...overrides }
}

function mockFeed(body: PatternFeed | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!body) throw new Error('offline')
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('the Pro feed', () => {
  it('states a pattern in plain English, with the sample it rests on', async () => {
    mockFeed({
      tier: 'pro',
      patterns: [card()],
      unattributed_catches: 0,
      hours_until_baseline: 0,
      computed_at: 1_789_000_000_000,
    })
    render(<PatternsView />)

    expect(await screen.findByText('You catch 3.2× as often on chartreuse.')).toBeTruthy()
    expect(screen.getByText('11 catches · 14 hrs · 6 trips')).toBeTruthy()
    expect(screen.getByText('3.2×')).toBeTruthy()
    expect(screen.getByText('Solid')).toBeTruthy()
  })

  it('labels an early signal as one rather than dressing it up', async () => {
    mockFeed({
      tier: 'pro',
      patterns: [card({ confidence: 'early', catches: 3, hours: 4, trips: 2, multiplier: 2.1 })],
      unattributed_catches: 0,
      hours_until_baseline: 0,
      computed_at: 1_789_000_000_000,
    })
    render(<PatternsView />)
    expect(await screen.findByText('Early signal')).toBeTruthy()
  })

  it('shows a collapse on the same terms as a lift', async () => {
    mockFeed({
      tier: 'pro',
      patterns: [card({ dimension: 'sky', bucket: 'clear', multiplier: 0.4 })],
      unattributed_catches: 0,
      hours_until_baseline: 0,
      computed_at: 1_789_000_000_000,
    })
    render(<PatternsView />)
    expect(await screen.findByText('You catch 0.4× as often under clear skies.')).toBeTruthy()
  })

  it('names the water a per-water pattern came from', async () => {
    mockFeed({
      tier: 'pro',
      patterns: [card({ scope: 'lake1', scope_name: 'Norris Lake' })],
      unattributed_catches: 0,
      hours_until_baseline: 0,
      computed_at: 1_789_000_000_000,
    })
    render(<PatternsView />)
    expect(await screen.findByText(/Norris Lake/)).toBeTruthy()
  })

  it('says when catches are missing from the rates, rather than quietly understating them', async () => {
    mockFeed({
      tier: 'pro',
      patterns: [card()],
      unattributed_catches: 3,
      hours_until_baseline: 0,
      computed_at: 1_789_000_000_000,
    })
    render(<PatternsView />)
    expect(await screen.findByText(/3 catches are not counted in these rates yet/)).toBeTruthy()
  })

  it('shows a progress meter, not a blank screen, while the data is thin', async () => {
    mockFeed({
      tier: 'pro',
      patterns: [],
      unattributed_catches: 0,
      hours_until_baseline: 6,
      computed_at: null,
    })
    render(<PatternsView />)
    expect(await screen.findByText('4 of 10 hours on the water')).toBeTruthy()
    expect(screen.getByText(/6 hours to go/)).toBeTruthy()
  })

  it('changes the story once the hours are there but the catches are not', async () => {
    mockFeed({
      tier: 'pro',
      patterns: [],
      unattributed_catches: 0,
      hours_until_baseline: 0,
      computed_at: 1_789_000_000_000,
    })
    render(<PatternsView />)
    expect(await screen.findByText('You have the hours. Now it needs the catches.')).toBeTruthy()
  })
})

describe('the free feed', () => {
  it('shows the true count and a card per pattern, with nothing to un-blur', async () => {
    mockFeed({
      tier: 'free',
      total: 3,
      teasers: [
        teaser(),
        teaser({ dimension_label: 'barometric pressure', confidence: 'solid' }),
        teaser({ dimension_label: 'time of day', confidence: 'early' }),
      ],
      hours_until_baseline: 0,
      computed_at: 1_789_000_000_000,
    })
    const { container } = render(<PatternsView />)

    expect(await screen.findByText('3 patterns found in your fishing.')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Unlock Pro' })).toBeTruthy()

    // Nothing the angler has not paid for is anywhere in the DOM, because nothing was sent.
    for (const secret of ['chartreuse', '3.2×', 'catches ·']) {
      expect(container.textContent).not.toContain(secret)
    }
  })

  it('says a count of one in the singular', async () => {
    mockFeed({
      tier: 'free',
      total: 1,
      teasers: [teaser()],
      hours_until_baseline: 0,
      computed_at: 1_789_000_000_000,
    })
    render(<PatternsView />)
    expect(await screen.findByText('1 pattern found in your fishing.')).toBeTruthy()
  })

  it('offers no upgrade when there is nothing yet to sell', async () => {
    mockFeed({ tier: 'free', total: 0, teasers: [], hours_until_baseline: 4, computed_at: null })
    render(<PatternsView />)
    expect(await screen.findByText('6 of 10 hours on the water')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Unlock Pro' })).toBeNull()
  })
})

describe('the notification opt-in', () => {
  function stubNotificationPermission(permission: NotificationPermission) {
    vi.stubGlobal('Notification', { permission, requestPermission: vi.fn() })
    vi.stubGlobal('navigator', { serviceWorker: {} })
  }

  const proFeed: PatternFeed = {
    tier: 'pro',
    patterns: [card()],
    unattributed_catches: 0,
    hours_until_baseline: 0,
    computed_at: 1_789_000_000_000,
  }

  it('offers to notify, and confirms once the angler accepts', async () => {
    mockFeed(proFeed)
    stubNotificationPermission('default')
    const registrar = { register: vi.fn(async () => ({ platform: 'web' as const, token: 'e' })) }
    render(<PatternsView registrar={registrar} />)

    const button = await screen.findByRole('button', { name: 'Tell me when a pattern lands' })
    button.click()

    expect(await screen.findByText('You will be told when a new pattern lands.')).toBeTruthy()
    expect(registrar.register).toHaveBeenCalledOnce()
  })

  it('takes a decline gracefully rather than asking again', async () => {
    mockFeed(proFeed)
    stubNotificationPermission('default')
    const registrar = { register: vi.fn(async () => null) }
    render(<PatternsView registrar={registrar} />)
    ;(await screen.findByRole('button', { name: 'Tell me when a pattern lands' })).click()

    expect(await screen.findByText(/No notifications then/)).toBeTruthy()
  })

  it('never prompts an angler who has already answered', async () => {
    mockFeed(proFeed)
    stubNotificationPermission('denied')
    const registrar = { register: vi.fn() }
    render(<PatternsView registrar={registrar} />)

    await screen.findByText('You catch 3.2× as often on chartreuse.')
    expect(screen.queryByRole('button', { name: 'Tell me when a pattern lands' })).toBeNull()
  })
})

describe('when the feed cannot be read', () => {
  it('blames the connection, not the angler', async () => {
    mockFeed(null)
    render(<PatternsView />)
    expect(
      await screen.findByText('Offline — patterns are computed on the server overnight.'),
    ).toBeTruthy()
  })
})
