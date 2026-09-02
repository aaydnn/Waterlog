import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { generateToken, sha256Hex } from '../src/lib/crypto'
import { SESSION_TTL_MS } from '../src/lib/sessions'

async function createUserAndSession(email: string): Promise<{ userId: string; cookie: string }> {
  const userId = crypto.randomUUID()
  const now = Date.now()
  await env.DB.prepare(
    "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES (?, ?, 'imperial', 'free', ?, ?)",
  )
    .bind(userId, email, now, now)
    .run()

  const raw = generateToken()
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(raw), userId, now + SESSION_TTL_MS, now)
    .run()

  return { userId, cookie: `session=${raw}` }
}

function sync(cookie: string, body: unknown) {
  return app.request(
    '/api/sync',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    },
    env,
  )
}

function tripInput(overrides: Record<string, unknown> = {}) {
  return {
    client_id: 'trp_client_1',
    water_body_id: null,
    started_at: 1_780_000_000_000,
    ended_at: null,
    auto_created: 0,
    planned: 1,
    notes: null,
    ...overrides,
  }
}

function catchInput(overrides: Record<string, unknown> = {}) {
  return {
    client_id: 'cat_client_1',
    trip_id: 'trp_client_1',
    lure_id: null,
    species: 'largemouth_bass',
    caught_at: 1_780_000_100_000,
    lat: null,
    lng: null,
    photo_key: null,
    length_mm: null,
    weight_g: null,
    depth_m: null,
    released: null,
    notes: null,
    ...overrides,
  }
}

describe('POST /api/sync', () => {
  it('401s without a session', async () => {
    const res = await sync('', { trips: [], catches: [] })
    expect(res.status).toBe(401)
  })

  it('400s on a malformed batch', async () => {
    const { cookie } = await createUserAndSession('malformed@example.com')
    const res = await sync(cookie, { trips: [{ water_body_id: null }] })
    expect(res.status).toBe(400)
  })

  it('creates a trip and a same-batch catch that references it by client_id', async () => {
    const { cookie } = await createUserAndSession('samebatch@example.com')
    const res = await sync(cookie, { trips: [tripInput()], catches: [catchInput()] })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { trips: { id: string; client_id: string }[]; catches: { trip_id: string; client_id: string }[]; errors: unknown[] }
    expect(body.trips).toHaveLength(1)
    expect(body.trips[0]!.client_id).toBe('trp_client_1')
    expect(body.catches).toHaveLength(1)
    expect(body.catches[0]!.client_id).toBe('cat_client_1')
    expect(body.catches[0]!.trip_id).toBe(body.trips[0]!.id)
    expect(body.errors).toEqual([])
  })

  it('replaying the same batch twice creates zero duplicates', async () => {
    const { cookie, userId } = await createUserAndSession('replay@example.com')
    const batch = { trips: [tripInput()], catches: [catchInput()] }

    const first = await sync(cookie, batch)
    const second = await sync(cookie, batch)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const firstBody = (await first.json()) as { trips: { id: string }[]; catches: { id: string }[] }
    const secondBody = (await second.json()) as { trips: { id: string }[]; catches: { id: string }[] }
    expect(secondBody.trips[0]!.id).toBe(firstBody.trips[0]!.id)
    expect(secondBody.catches[0]!.id).toBe(firstBody.catches[0]!.id)

    const trips = await env.DB.prepare('SELECT count(*) AS n FROM trips WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    const catches = await env.DB.prepare('SELECT count(*) AS n FROM catches WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(trips!.n).toBe(1)
    expect(catches!.n).toBe(1)
  })

  it('a catch synced with no trip_id gets a synthetic 1h orphan trip', async () => {
    const { cookie } = await createUserAndSession('orphan@example.com')
    const res = await sync(cookie, {
      catches: [catchInput({ client_id: 'cat_orphan', trip_id: undefined })],
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      trips: { id: string; auto_created: number; started_at: number; ended_at: number }[]
      catches: { trip_id: string }[]
    }
    expect(body.trips).toHaveLength(1)
    expect(body.trips[0]!.auto_created).toBe(1)
    expect(body.trips[0]!.ended_at - body.trips[0]!.started_at).toBe(60 * 60 * 1000)
    expect(body.catches[0]!.trip_id).toBe(body.trips[0]!.id)
  })

  it('a catch can reference a trip synced in an earlier batch by its server id', async () => {
    const { cookie } = await createUserAndSession('twobatch@example.com')
    const tripRes = await sync(cookie, { trips: [tripInput()] })
    const tripBody = (await tripRes.json()) as { trips: { id: string }[] }
    const serverTripId = tripBody.trips[0]!.id

    const catchRes = await sync(cookie, {
      catches: [catchInput({ trip_id: serverTripId })],
    })
    expect(catchRes.status).toBe(200)
    const catchBody = (await catchRes.json()) as { catches: { trip_id: string }[] }
    expect(catchBody.catches[0]!.trip_id).toBe(serverTripId)
  })

  it('a catch referencing an unresolvable trip_id is reported as an error, not inserted', async () => {
    const { cookie } = await createUserAndSession('badref@example.com')
    const res = await sync(cookie, {
      catches: [catchInput({ client_id: 'cat_bad', trip_id: 'nonexistent_trip' })],
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { catches: unknown[]; errors: { client_id: string }[] }
    expect(body.catches).toEqual([])
    expect(body.errors).toEqual([{ client_id: 'cat_bad', message: expect.stringContaining('nonexistent_trip') }])

    const row = await env.DB.prepare('SELECT id FROM catches WHERE client_id = ?').bind('cat_bad').first()
    expect(row).toBeNull()
  })

  it("does not resolve another user's trip id (no cross-tenant leakage)", async () => {
    const owner = await createUserAndSession('owner@example.com')
    const attacker = await createUserAndSession('attacker@example.com')

    const ownerTripRes = await sync(owner.cookie, { trips: [tripInput()] })
    const ownerTripBody = (await ownerTripRes.json()) as { trips: { id: string }[] }
    const ownerTripId = ownerTripBody.trips[0]!.id

    const res = await sync(attacker.cookie, {
      catches: [catchInput({ client_id: 'cat_attack', trip_id: ownerTripId })],
    })
    const body = (await res.json()) as { catches: unknown[]; errors: { client_id: string }[] }
    expect(body.catches).toEqual([])
    expect(body.errors[0]!.client_id).toBe('cat_attack')
  })
})
