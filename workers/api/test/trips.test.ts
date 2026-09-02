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

function sync(cookie: string, body: unknown) {
  return app.request(
    '/api/sync',
    { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) },
    env,
  )
}

function endTrip(cookie: string, tripId: string, endedAt: number) {
  return app.request(
    `/api/trips/${tripId}/end`,
    { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ ended_at: endedAt }) },
    env,
  )
}

describe('PATCH /api/trips/:id/end', () => {
  it('401s without a session', async () => {
    const res = await app.request(
      '/api/trips/anything/end',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ended_at: 1 }) },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('404s for an unknown trip id', async () => {
    const { cookie } = await createUserAndSession('noend@example.com')
    const res = await endTrip(cookie, 'nonexistent', 1_780_000_000_000)
    expect(res.status).toBe(404)
  })

  it('ends an open trip', async () => {
    const { cookie } = await createUserAndSession('ender@example.com')
    const syncRes = await sync(cookie, {
      trips: [{ client_id: 't1', water_body_id: null, started_at: 1_780_000_000_000, ended_at: null, auto_created: 0, planned: 1, notes: null }],
    })
    const { trips } = (await syncRes.json()) as { trips: { id: string }[] }

    const res = await endTrip(cookie, trips[0]!.id, 1_780_003_600_000)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { trip: { ended_at: number } }
    expect(body.trip.ended_at).toBe(1_780_003_600_000)
  })

  it('is idempotent: replaying the end never overwrites the real end time', async () => {
    const { cookie } = await createUserAndSession('replay-end@example.com')
    const syncRes = await sync(cookie, {
      trips: [{ client_id: 't1', water_body_id: null, started_at: 1_780_000_000_000, ended_at: null, auto_created: 0, planned: 1, notes: null }],
    })
    const { trips } = (await syncRes.json()) as { trips: { id: string }[] }

    await endTrip(cookie, trips[0]!.id, 1_780_003_600_000)
    const replay = await endTrip(cookie, trips[0]!.id, 9_999_999_999_999) // a stale/different end time
    expect(replay.status).toBe(200)
    const body = (await replay.json()) as { trip: { ended_at: number } }
    expect(body.trip.ended_at).toBe(1_780_003_600_000) // unchanged, not overwritten
  })

  it("does not end another user's trip", async () => {
    const owner = await createUserAndSession('tripowner@example.com')
    const attacker = await createUserAndSession('tripattacker@example.com')
    const syncRes = await sync(owner.cookie, {
      trips: [{ client_id: 't1', water_body_id: null, started_at: 1_780_000_000_000, ended_at: null, auto_created: 0, planned: 1, notes: null }],
    })
    const { trips } = (await syncRes.json()) as { trips: { id: string }[] }

    const res = await endTrip(attacker.cookie, trips[0]!.id, 1_780_003_600_000)
    expect(res.status).toBe(404)
  })
})
