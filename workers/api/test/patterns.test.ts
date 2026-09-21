import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { generateToken, sha256Hex } from '../src/lib/crypto'
import { SESSION_TTL_MS } from '../src/lib/sessions'
import { dimensionLabel } from '../src/lib/patterns'
import type { PatternFeed } from '@waterlog/schema'

const NOW = Date.UTC(2026, 8, 15, 8)

async function createUser(email: string, tier: 'free' | 'pro'): Promise<{ userId: string; cookie: string }> {
  const userId = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(userId, email, 'imperial', tier, NOW, NOW)
    .run()

  const raw = generateToken()
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(raw), userId, Date.now() + SESSION_TTL_MS, NOW)
    .run()
  return { userId, cookie: `session=${raw}` }
}

interface SeedPattern {
  scope?: string
  dimension?: string
  bucket?: string
  multiplier?: number
  confidence?: 'early' | 'promising' | 'solid'
}

let patternSeq = 0

async function seedPattern(userId: string, overrides: SeedPattern = {}): Promise<void> {
  patternSeq += 1
  const pattern = {
    scope: 'all',
    dimension: 'lure_color',
    bucket: 'chartreuse',
    multiplier: 3.2,
    confidence: 'solid' as const,
    ...overrides,
  }
  await env.DB.prepare(
    `INSERT INTO pattern_cache (id, user_id, scope, dimension, bucket, catches, hours, rate, baseline_rate, multiplier, confidence, trips, computed_at)
     VALUES (?, ?, ?, ?, ?, 11, 14, 0.7857142857142857, 0.2455357142857143, ?, ?, 6, ?)`,
  )
    .bind(
      `pat_${patternSeq}`,
      userId,
      pattern.scope,
      pattern.dimension,
      pattern.bucket,
      pattern.multiplier,
      pattern.confidence,
      NOW,
    )
    .run()
}

async function seedHours(userId: string, count: number): Promise<void> {
  const tripId = `trip_${userId.slice(0, 8)}`
  await env.DB.prepare(
    `INSERT INTO trips (id, user_id, started_at, ended_at, auto_created, planned, created_at, updated_at, client_id)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
  )
    .bind(tripId, userId, NOW, NOW + count * 3_600_000, NOW, NOW, `c_${tripId}`)
    .run()
  for (let i = 0; i < count; i += 1) {
    await env.DB.prepare(
      'INSERT INTO conditions (id, user_id, trip_id, hour_bucket, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(`cond_${tripId}_${i}`, userId, tripId, 490_000 + i, NOW)
      .run()
  }
}

function getFeed(cookie: string, query = '') {
  return app.request(`/api/patterns${query}`, { headers: { cookie } }, env)
}

describe('GET /api/patterns', () => {
  it('401s without a session', async () => {
    expect((await app.request('/api/patterns', {}, env)).status).toBe(401)
  })

  it('gives a Pro angler the whole card', async () => {
    const { userId, cookie } = await createUser('pro-feed@example.com', 'pro')
    await seedPattern(userId)

    const body = (await (await getFeed(cookie)).json()) as PatternFeed
    expect(body.tier).toBe('pro')
    if (body.tier !== 'pro') throw new Error('unreachable')
    expect(body.patterns).toHaveLength(1)
    expect(body.patterns[0]).toMatchObject({
      dimension: 'lure_color',
      bucket: 'chartreuse',
      catches: 11,
      hours: 14,
      multiplier: 3.2,
      confidence: 'solid',
      // Without this the card footer reads 'undefined trips' — the count has to survive the trip
      // from the engine, through the cache, to the wire.
      trips: 6,
    })
  })

  it('sorts by how far from ordinary a pattern is, strongest first', async () => {
    const { userId, cookie } = await createUser('sorted@example.com', 'pro')
    await seedPattern(userId, { bucket: 'mild', multiplier: 1.6 })
    await seedPattern(userId, { bucket: 'collapse', multiplier: 0.2 })
    await seedPattern(userId, { bucket: 'strong', multiplier: 4 })

    const body = (await (await getFeed(cookie)).json()) as PatternFeed
    if (body.tier !== 'pro') throw new Error('unreachable')
    // 4× and 0.2× are both bigger findings than 1.6×; a collapse is not sorted last for being one.
    expect(body.patterns.map((p) => p.bucket)).toEqual(['strong', 'collapse', 'mild'])
  })

  it('names the water a per-water pattern belongs to', async () => {
    const { userId, cookie } = await createUser('scoped@example.com', 'pro')
    await env.DB.prepare(
      "INSERT INTO water_bodies (id, user_id, name, kind, created_at, updated_at) VALUES ('lake1', ?, 'Norris Lake', 'reservoir', ?, ?)",
    )
      .bind(userId, NOW, NOW)
      .run()
    await seedPattern(userId, { scope: 'lake1' })

    const body = (await (await getFeed(cookie)).json()) as PatternFeed
    if (body.tier !== 'pro') throw new Error('unreachable')
    expect(body.patterns[0]!.scope_name).toBe('Norris Lake')
  })

  it('never returns another angler\'s patterns', async () => {
    const owner = await createUser('pattern-owner@example.com', 'pro')
    const other = await createUser('pattern-other@example.com', 'pro')
    await seedPattern(owner.userId)

    const body = (await (await getFeed(other.cookie)).json()) as PatternFeed
    if (body.tier !== 'pro') throw new Error('unreachable')
    expect(body.patterns).toEqual([])
  })

  it('filters to one water when asked, and 404s for a water the angler does not own', async () => {
    const { userId, cookie } = await createUser('filtered@example.com', 'pro')
    await env.DB.prepare(
      "INSERT INTO water_bodies (id, user_id, name, kind, created_at, updated_at) VALUES ('mine_lake', ?, 'Mine', 'lake', ?, ?)",
    )
      .bind(userId, NOW, NOW)
      .run()
    await seedPattern(userId, { scope: 'mine_lake', bucket: 'here' })
    await seedPattern(userId, { scope: 'all', bucket: 'everywhere' })

    const body = (await (await getFeed(cookie, '?scope=mine_lake')).json()) as PatternFeed
    if (body.tier !== 'pro') throw new Error('unreachable')
    expect(body.patterns.map((p) => p.bucket)).toEqual(['here'])

    expect((await getFeed(cookie, '?scope=someone_elses_lake')).status).toBe(404)
  })

  it('tells a Pro angler how many catches no rate could count', async () => {
    const { userId, cookie } = await createUser('unattributed@example.com', 'pro')
    await env.DB.prepare(
      'INSERT INTO pattern_runs (user_id, completed_at, unattributed_catches, updated_at) VALUES (?, ?, 4, ?)',
    )
      .bind(userId, NOW, NOW)
      .run()

    const body = (await (await getFeed(cookie)).json()) as PatternFeed
    if (body.tier !== 'pro') throw new Error('unreachable')
    expect(body.unattributed_catches).toBe(4)
    expect(body.computed_at).toBe(NOW)
  })
})

describe('the paywall, proved at the wire', () => {
  it('sends a free angler the true count and nothing they have not paid for', async () => {
    const { userId, cookie } = await createUser('free-feed@example.com', 'free')
    await seedPattern(userId, { bucket: 'chartreuse', multiplier: 3.2 })
    await seedPattern(userId, { dimension: 'pressure_trend', bucket: 'falling', multiplier: 2.1 })
    await seedPattern(userId, { dimension: 'time_block', bucket: 'dawn', multiplier: 0.3 })

    const response = await getFeed(cookie)
    const raw = await response.text()
    const body = JSON.parse(raw) as PatternFeed

    expect(body.tier).toBe('free')
    if (body.tier !== 'free') throw new Error('unreachable')
    // The tease is true: three patterns is what this angler's own fishing actually holds.
    expect(body.total).toBe(3)
    expect(body.teasers).toHaveLength(3)

    // And nothing else made it across. Asserted against the raw payload, not the parsed object,
    // because the thing being sold is whatever a devtools tab can read.
    for (const secret of ['chartreuse', 'falling', 'dawn', '3.2', '2.1', '0.3', '"multiplier"', '"catches"', '"hours"', '"rate"', '"bucket"']) {
      expect(raw).not.toContain(secret)
    }
  })

  it('says what kind of thing each hidden pattern is about, and no more', async () => {
    const { userId, cookie } = await createUser('teaser@example.com', 'free')
    await seedPattern(userId, { dimension: 'lure_color', confidence: 'promising' })

    const body = (await (await getFeed(cookie)).json()) as PatternFeed
    if (body.tier !== 'free') throw new Error('unreachable')
    expect(body.teasers[0]).toEqual({
      id: expect.any(String),
      dimension_label: 'your lure colour',
      confidence: 'promising',
    })
  })

  it('counts every pattern even past the page limit, so the number stays the true one', async () => {
    const { userId, cookie } = await createUser('many@example.com', 'free')
    for (let i = 0; i < 65; i += 1) await seedPattern(userId, { bucket: `b${i}` })

    const body = (await (await getFeed(cookie)).json()) as PatternFeed
    if (body.tier !== 'free') throw new Error('unreachable')
    expect(body.total).toBe(65)
    expect(body.teasers).toHaveLength(60)
  })
})

describe('the progress meter', () => {
  it('counts down the hours left before any rate can exist', async () => {
    const { userId, cookie } = await createUser('progress@example.com', 'pro')
    await seedHours(userId, 4)

    const body = (await (await getFeed(cookie)).json()) as PatternFeed
    expect(body.hours_until_baseline).toBe(6)
  })

  it('reaches zero once the angler has a baseline', async () => {
    const { userId, cookie } = await createUser('enough@example.com', 'pro')
    await seedHours(userId, 12)

    const body = (await (await getFeed(cookie)).json()) as PatternFeed
    expect(body.hours_until_baseline).toBe(0)
  })

  it('reports never having run as null rather than as a date', async () => {
    const { cookie } = await createUser('never@example.com', 'pro')
    const body = (await (await getFeed(cookie)).json()) as PatternFeed
    expect(body.computed_at).toBeNull()
  })
})

describe('dimension labels', () => {
  it.each([
    ['lure_color', 'your lure colour'],
    ['pressure_trend', 'barometric pressure'],
    ['time_block', 'time of day'],
  ] as [string, string][])('describes %s as "%s"', (dimension, expected) => {
    expect(dimensionLabel(dimension)).toBe(expected)
  })

  it('joins a pairing without naming either bucket', () => {
    expect(dimensionLabel('lure_color+pressure_trend')).toBe('your lure colour and barometric pressure')
  })

  it('falls back to the raw dimension name for one it has no label for', () => {
    expect(dimensionLabel('depth_band')).toBe('depth band')
  })
})
