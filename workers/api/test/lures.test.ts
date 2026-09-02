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

describe('GET /api/lures', () => {
  it('401s without a session', async () => {
    const res = await app.request('/api/lures', {}, env)
    expect(res.status).toBe(401)
  })

  it("lists only the current user's lures", async () => {
    const { cookie } = await createUserAndSession('angler1@example.com')
    const other = await createUserAndSession('angler2@example.com')

    await app.request(
      '/api/lures',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'War Eagle Spinnerbait' }) },
      env,
    )
    await app.request(
      '/api/lures',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Ned Rig' }) },
      env,
    )
    await app.request(
      '/api/lures',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie: other.cookie }, body: JSON.stringify({ name: "Someone else's jig" }) },
      env,
    )

    const res = await app.request('/api/lures', { headers: { cookie } }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lures: { name: string }[] }
    expect(body.lures.map((l) => l.name).sort()).toEqual(['Ned Rig', 'War Eagle Spinnerbait'])
  })
})

describe('POST /api/lures', () => {
  it('creates a lure with defaults for optional fields', async () => {
    const { cookie } = await createUserAndSession('quickadd@example.com')
    const res = await app.request(
      '/api/lures',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Zoom Fluke' }) },
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { lure: { name: string; family: null; color: null; cost_cents: null } }
    expect(body.lure.name).toBe('Zoom Fluke')
    expect(body.lure.family).toBeNull()
    expect(body.lure.color).toBeNull()
    expect(body.lure.cost_cents).toBeNull()
  })

  it('400s on a missing name', async () => {
    const { cookie } = await createUserAndSession('badlure@example.com')
    const res = await app.request(
      '/api/lures',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({}) },
      env,
    )
    expect(res.status).toBe(400)
  })
})
