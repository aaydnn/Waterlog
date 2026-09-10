import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
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
    // A stale/different end time — but still a plausible one: a wild timestamp is now refused
    // outright (see 'refuses to end a trip a year after it started').
    const replay = await endTrip(cookie, trips[0]!.id, 1_780_010_800_000)
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

// Finding 4: the end-trip route is the other door onto trip duration. Without the same ceiling
// sync applies, a trip left open for months could be closed "now" and bill a year of hourly
// enrichment (8,760 conditions rows) to a single PATCH.
describe('PATCH /api/trips/:id/end — bounded trip duration', () => {
  async function openTrip(cookie: string, startedAt: number, clientId = 'bounded_trip') {
    const res = await sync(cookie, {
      trips: [{ client_id: clientId, water_body_id: null, started_at: startedAt, ended_at: null, auto_created: 0, planned: 0, notes: null }],
    })
    const { trips } = (await res.json()) as { trips: { id: string }[] }
    return trips[0]!.id
  }

  it('clamps a trip ended a year after it started to 48h, closing it rather than stranding it', async () => {
    const { cookie } = await createUserAndSession('year-long@example.com')
    const started = Date.now() - 365 * 24 * 3_600_000
    const tripId = await openTrip(cookie, started)

    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    try {
      // What the client's "End trip" button actually sends for a trip nobody closed.
      const res = await endTrip(cookie, tripId, Date.now())
      expect(res.status).toBe(200)
      const body = (await res.json()) as { trip: { ended_at: number } }
      expect(body.trip.ended_at).toBe(started + 48 * 3_600_000) // returned clamped, so the client mirrors it

      const row = await env.DB.prepare('SELECT ended_at FROM trips WHERE id = ?').bind(tripId).first<{ ended_at: number | null }>()
      expect(row!.ended_at).toBe(started + 48 * 3_600_000) // and persisted clamped

      // Bounded work: 48 hours of enrichment, not 8,760.
      expect(send).toHaveBeenCalledOnce()
      expect((send.mock.calls[0]![0] as { hour_buckets: number[] }).hour_buckets).toHaveLength(48)
    } finally { send.mockRestore() }
  })

  it('refuses an ended_at before the trip started', async () => {
    const { cookie } = await createUserAndSession('backwards@example.com')
    const started = Date.now() - 2 * 3_600_000
    const tripId = await openTrip(cookie, started)
    const res = await endTrip(cookie, tripId, started - 60_000)
    expect(res.status).toBe(400)
  })

  it('refuses an ended_at far in the future', async () => {
    const { cookie } = await createUserAndSession('future-end@example.com')
    const started = Date.now() - 3_600_000
    const tripId = await openTrip(cookie, started)
    expect((await endTrip(cookie, tripId, Date.now() + 40 * 24 * 3_600_000)).status).toBe(400)
  })

  it('still accepts a long-but-plausible overnight trip at the 48h ceiling', async () => {
    const { cookie } = await createUserAndSession('overnighter@example.com')
    const started = Date.now() - 48 * 3_600_000
    const tripId = await openTrip(cookie, started)
    const res = await endTrip(cookie, tripId, started + 48 * 3_600_000)
    expect(res.status).toBe(200)
  })

  it('404s before validating, so a bad time on an unknown trip is still a 404', async () => {
    const { cookie } = await createUserAndSession('unknown-bad-time@example.com')
    expect((await endTrip(cookie, 'nonexistent', 1)).status).toBe(404)
  })
})

// Finding 1: the client stamps the account it queued for; a session that has since changed
// accounts must not have the write re-homed onto it.
describe('PATCH /api/trips/:id/end — X-Waterlog-User binding', () => {
  function endTripAs(cookie: string, tripId: string, endedAt: number, expectedUser?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json', cookie }
    if (expectedUser !== undefined) headers['X-Waterlog-User'] = expectedUser
    return app.request(
      `/api/trips/${tripId}/end`,
      { method: 'PATCH', headers, body: JSON.stringify({ ended_at: endedAt }) },
      env,
    )
  }

  async function openTripFor(cookie: string) {
    const started = Date.now() - 3_600_000
    const res = await sync(cookie, {
      trips: [{ client_id: 'hdr_trip', water_body_id: null, started_at: started, ended_at: null, auto_created: 0, planned: 0, notes: null }],
    })
    const { trips } = (await res.json()) as { trips: { id: string }[] }
    return { tripId: trips[0]!.id, started }
  }

  it('ends the trip when the header matches the session', async () => {
    const { cookie, userId } = await createUserAndSession('hdr-match-end@example.com')
    const { tripId, started } = await openTripFor(cookie)
    expect((await endTripAs(cookie, tripId, started + 3_600_000, userId)).status).toBe(200)
  })

  it('409s with session_mismatch when the header names a different account, before any write', async () => {
    const { cookie } = await createUserAndSession('hdr-mismatch-end@example.com')
    const { tripId, started } = await openTripFor(cookie)

    const res = await endTripAs(cookie, tripId, started + 3_600_000, 'somebody-else')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'session_mismatch' })

    const row = await env.DB.prepare('SELECT ended_at FROM trips WHERE id = ?').bind(tripId).first<{ ended_at: number | null }>()
    expect(row!.ended_at).toBeNull()
  })

  it('proceeds as before when the header is absent (older clients)', async () => {
    const { cookie } = await createUserAndSession('hdr-absent-end@example.com')
    const { tripId, started } = await openTripFor(cookie)
    expect((await endTripAs(cookie, tripId, started + 3_600_000)).status).toBe(200)
  })
})
