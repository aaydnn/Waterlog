import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { generateToken, sha256Hex } from '../src/lib/crypto'
import { SESSION_TTL_MS } from '../src/lib/sessions'

async function createUserAndSession(email: string): Promise<{ cookie: string }> {
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

  return { cookie: `session=${raw}` }
}

function post(path: string, cookie: string, body: unknown) {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) },
    env,
  )
}

interface WaterBodyBody {
  water_body: {
    id: string
    name: string
    kind: string | null
    centroid_lat: number | null
    nwps_gauge_id: string | null
    is_home: 0 | 1
  }
}

describe('GET /api/water-bodies', () => {
  it('401s without a session', async () => {
    const res = await app.request('/api/water-bodies', {}, env)
    expect(res.status).toBe(401)
  })

  it("lists only the current user's waters, home water first", async () => {
    const { cookie } = await createUserAndSession('waters1@example.com')
    const other = await createUserAndSession('waters2@example.com')

    await post('/api/water-bodies', cookie, { name: 'Watauga Lake' })
    await post('/api/water-bodies', cookie, { name: 'Norris Lake', is_home: 1 })
    await post('/api/water-bodies', other.cookie, { name: "Someone else's pond" })

    const res = await app.request('/api/water-bodies', { headers: { cookie } }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { water_bodies: { name: string }[] }
    expect(body.water_bodies.map((w) => w.name)).toEqual(['Norris Lake', 'Watauga Lake'])
  })
})

describe('POST /api/water-bodies', () => {
  it('creates a water with defaults for everything but the name', async () => {
    const { cookie } = await createUserAndSession('addwater@example.com')
    const res = await post('/api/water-bodies', cookie, { name: 'Lake Oliphant' })

    expect(res.status).toBe(201)
    const { water_body } = (await res.json()) as WaterBodyBody
    expect(water_body.name).toBe('Lake Oliphant')
    expect(water_body.kind).toBeNull()
    expect(water_body.centroid_lat).toBeNull()
    expect(water_body.is_home).toBe(0)
  })

  it('keeps an explicitly mapped pool gauge (ADR-0008)', async () => {
    const { cookie } = await createUserAndSession('poolgauge@example.com')
    const res = await post('/api/water-bodies', cookie, {
      name: 'Norris Lake',
      kind: 'reservoir',
      centroid_lat: 36.2331,
      centroid_lng: -83.9143,
      nwps_gauge_id: 'NRST1',
    })

    const { water_body } = (await res.json()) as WaterBodyBody
    expect(water_body.nwps_gauge_id).toBe('NRST1')
    expect(water_body.kind).toBe('reservoir')
    expect(water_body.centroid_lat).toBeCloseTo(36.2331)
  })

  it('400s on a missing name and on an off-globe centroid', async () => {
    const { cookie } = await createUserAndSession('badwater@example.com')
    expect((await post('/api/water-bodies', cookie, {})).status).toBe(400)
    expect((await post('/api/water-bodies', cookie, { name: 'Nowhere', centroid_lat: 99 })).status).toBe(400)
  })
})

describe('POST /api/sync with a water body', () => {
  it('attaches an owned water to the trip', async () => {
    const { cookie } = await createUserAndSession('synced-water@example.com')
    const { water_body } = (await (await post('/api/water-bodies', cookie, { name: 'Norris Lake' })).json()) as WaterBodyBody

    const res = await post('/api/sync', cookie, {
      trips: [
        {
          client_id: '01J0TRIPWATER0000000000001',
          water_body_id: water_body.id,
          started_at: Date.now(),
          ended_at: null,
          auto_created: 0,
          planned: 0,
          notes: null,
        },
      ],
      catches: [],
    })

    const body = (await res.json()) as { trips: { water_body_id: string | null }[]; errors: unknown[] }
    expect(body.errors).toEqual([])
    expect(body.trips[0]!.water_body_id).toBe(water_body.id)
  })

  it("rejects a trip pointing at another angler's water instead of writing it", async () => {
    const mine = await createUserAndSession('mine-water@example.com')
    const theirs = await createUserAndSession('their-water@example.com')
    const { water_body } = (await (await post('/api/water-bodies', theirs.cookie, { name: 'Their Pond' })).json()) as WaterBodyBody

    const res = await post('/api/sync', mine.cookie, {
      trips: [
        {
          client_id: '01J0TRIPWATER0000000000002',
          water_body_id: water_body.id,
          started_at: Date.now(),
          ended_at: null,
          auto_created: 0,
          planned: 0,
          notes: null,
        },
      ],
      catches: [],
    })

    const body = (await res.json()) as { trips: unknown[]; errors: { client_id: string; message: string }[] }
    expect(body.trips).toEqual([])
    expect(body.errors[0]!.message).toContain('not found')

    const row = await env.DB.prepare('SELECT id FROM trips WHERE client_id = ?')
      .bind('01J0TRIPWATER0000000000002')
      .first()
    expect(row).toBeNull()
  })
})
