import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
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
  it('repairs a failed queue send when ending the same trip again', async () => {
    const { cookie } = await createUserAndSession('end-send-retry@example.com')
    const started = Date.UTC(2026, 5, 1, 10)
    const response = await sync(cookie, {
      trips: [{ client_id: 'retry_trip', water_body_id: null, started_at: started, ended_at: null, auto_created: 0, planned: 0, notes: null }],
    })
    const { trips } = await response.json() as { trips: { id: string }[] }
    const send = vi.spyOn(env.ENRICH_QUEUE, 'send').mockRejectedValueOnce(new Error('queue unavailable'))
    try {
      expect((await endTrip(cookie, trips[0]!.id, started + 3_600_000)).status).toBe(500)
      expect((await endTrip(cookie, trips[0]!.id, started + 7_200_000)).status).toBe(200)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1]![0]).toMatchObject({ hour_buckets: [Math.floor(started / 3_600_000)] })
    } finally { send.mockRestore() }
  })

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

  it('ending a 4.5h trip sends one trip_hours enrich job with 5 hour buckets', async () => {
    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    const { cookie } = await createUserAndSession('backfill@example.com')
    const started = Date.UTC(2026, 5, 1, 10, 15)
    const syncRes = await sync(cookie, {
      trips: [{ client_id: 'bt1', water_body_id: null, started_at: started, ended_at: null, auto_created: 0, planned: 1, notes: null }],
    })
    const { trips } = (await syncRes.json()) as { trips: { id: string }[] }

    const ended = started + 4.5 * 60 * 60 * 1000
    const res = await endTrip(cookie, trips[0]!.id, ended)
    expect(res.status).toBe(200)

    expect(send).toHaveBeenCalledOnce()
    const [message] = send.mock.calls[0]!
    expect(message).toMatchObject({ type: 'trip_hours', trip_id: trips[0]!.id })
    expect((message as { hour_buckets: number[] }).hour_buckets).toHaveLength(5)

    send.mockRestore()
  })

  it('replaying an already-ended trip does not re-enqueue trip-hour backfill', async () => {
    const { cookie } = await createUserAndSession('backfill-replay@example.com')
    const started = 1_780_000_000_000
    const syncRes = await sync(cookie, {
      trips: [{ client_id: 'bt2', water_body_id: null, started_at: started, ended_at: null, auto_created: 0, planned: 1, notes: null }],
    })
    const { trips } = (await syncRes.json()) as { trips: { id: string }[] }

    await endTrip(cookie, trips[0]!.id, started + 60 * 60 * 1000)
    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    await endTrip(cookie, trips[0]!.id, started + 999 * 60 * 60 * 1000) // replay with a different (stale) end time
    expect(send).not.toHaveBeenCalled()
    send.mockRestore()
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
