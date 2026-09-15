import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { generateToken, sha256Hex } from '../src/lib/crypto'
import { DISPATCH_WINDOW_MS, MAX_DISPATCHES_PER_WINDOW } from '../src/lib/enrichment'
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
  it('does not enqueue or return another owner\'s rows through a colliding client_id', async () => {
    const owner = await createUserAndSession('collision-owner@example.com')
    const other = await createUserAndSession('collision-other@example.com')
    await sync(owner.cookie, { trips: [tripInput()], catches: [catchInput()] })
    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    try {
      const tripCollision = await sync(other.cookie, { trips: [tripInput()] })
      expect(tripCollision.status).toBe(500)
      const catchCollision = await sync(other.cookie, {
        trips: [tripInput({ client_id: 'other_trip' })],
        catches: [catchInput({ trip_id: 'other_trip' })],
      })
      expect(catchCollision.status).toBe(500)
      expect(send).not.toHaveBeenCalled()
    } finally { send.mockRestore() }
  })

  it('backfills a completed offline trip and an orphan trip, once per trip', async () => {
    const { cookie } = await createUserAndSession('offline-backfill@example.com')
    const started = Date.UTC(2026, 5, 1, 10, 15)
    const batch = {
      trips: [tripInput({ started_at: started, ended_at: started + 4.5 * 3_600_000 })],
      catches: [catchInput(), catchInput({ client_id: 'orphan_backfill', trip_id: undefined })],
    }
    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    try {
      expect((await sync(cookie, batch)).status).toBe(200)
      const jobs = send.mock.calls.map(([job]) => job).filter((job) => job.type === 'trip_hours')
      expect(jobs).toHaveLength(2)
      expect(jobs.map((job) => job.hour_buckets.length).sort()).toEqual([1, 5])
      send.mockClear()
      expect((await sync(cookie, batch)).status).toBe(200)
      expect(send).not.toHaveBeenCalled()
    } finally { send.mockRestore() }
  })

  it('retries a failed catch queue send on replay without duplicating catches', async () => {
    const { cookie, userId } = await createUserAndSession('dispatch-retry@example.com')
    const batch = { trips: [tripInput()], catches: [catchInput()] }
    const send = vi.spyOn(env.ENRICH_QUEUE, 'send').mockRejectedValueOnce(new Error('queue unavailable'))
    try {
      expect((await sync(cookie, batch)).status).toBe(500)
      expect((await sync(cookie, batch)).status).toBe(200)
      expect(send).toHaveBeenCalledTimes(2)
      const rows = await env.DB.prepare('SELECT id FROM catches WHERE user_id = ?').bind(userId).all()
      expect(rows.results).toHaveLength(1)
    } finally { send.mockRestore() }
  })

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

  it('replaying an orphan-catch batch twice creates exactly one orphan trip, not two', async () => {
    const { cookie, userId } = await createUserAndSession('orphan-replay@example.com')
    const batch = { catches: [catchInput({ client_id: 'cat_orphan_replay', trip_id: undefined })] }

    const first = await sync(cookie, batch)
    const second = await sync(cookie, batch)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const firstBody = (await first.json()) as { trips: { id: string }[] }
    const secondBody = (await second.json()) as { trips: { id: string }[] }
    expect(secondBody.trips[0]!.id).toBe(firstBody.trips[0]!.id)

    const trips = await env.DB.prepare(
      "SELECT count(*) AS n FROM trips WHERE user_id = ? AND auto_created = 1",
    )
      .bind(userId)
      .first<{ n: number }>()
    expect(trips!.n).toBe(1)
  })

  it('enqueues an enrich job only for a genuinely new catch, never on replay', async () => {
    const { cookie } = await createUserAndSession('enqueue-once@example.com')
    const batch = { trips: [tripInput()], catches: [catchInput()] }

    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    await sync(cookie, batch)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]![0]).toMatchObject({ type: 'catch' })

    send.mockClear()
    await sync(cookie, batch) // replay
    expect(send).not.toHaveBeenCalled()
    send.mockRestore()
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

// Finding 1: the client names the account it queued its rows for. If the session has since
// become a different angler's, the batch must be refused, not re-homed onto that angler.
describe('POST /api/sync â€” X-Waterlog-User binding', () => {
  function syncAs(cookie: string, body: unknown, expectedUser?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json', cookie }
    if (expectedUser !== undefined) headers['X-Waterlog-User'] = expectedUser
    return app.request('/api/sync', { method: 'POST', headers, body: JSON.stringify(body) }, env)
  }

  it('accepts the batch when the header matches the session user', async () => {
    const { cookie, userId } = await createUserAndSession('hdr-match@example.com')
    const res = await syncAs(cookie, { trips: [tripInput()] }, userId)
    expect(res.status).toBe(200)
  })

  it('409s with session_mismatch when the header names another account, writing nothing', async () => {
    const { cookie, userId } = await createUserAndSession('hdr-mismatch@example.com')
    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    try {
      const res = await syncAs(cookie, { trips: [tripInput()], catches: [catchInput()] }, 'someone-else')
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'session_mismatch' })
      expect(send).not.toHaveBeenCalled()

      const rows = await env.DB.prepare('SELECT count(*) AS n FROM trips WHERE user_id = ?').bind(userId).first<{ n: number }>()
      expect(rows!.n).toBe(0)
    } finally { send.mockRestore() }
  })

  it('accepts a batch with no header at all (clients deployed before the contract)', async () => {
    const { cookie } = await createUserAndSession('hdr-absent@example.com')
    expect((await syncAs(cookie, { trips: [tripInput()] })).status).toBe(200)
  })
})

// Finding 4: unbounded input is unbounded work. Every row costs a write and, for most, an
// outbound enrichment job, so the batch is bounded before anything is persisted.
describe('POST /api/sync â€” bounded input', () => {
  it('400s a batch with more than 200 trips, persisting none of them', async () => {
    const { cookie, userId } = await createUserAndSession('too-many-trips@example.com')
    const trips = Array.from({ length: 201 }, (_, i) => tripInput({ client_id: `bulk_trip_${i}` }))

    const res = await sync(cookie, { trips })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'sync batch too large' })

    const rows = await env.DB.prepare('SELECT count(*) AS n FROM trips WHERE user_id = ?').bind(userId).first<{ n: number }>()
    expect(rows!.n).toBe(0)
  })

  it('accepts a batch at exactly the trip ceiling', async () => {
    const { cookie } = await createUserAndSession('at-trip-ceiling@example.com')
    const trips = Array.from({ length: 200 }, (_, i) => tripInput({ client_id: `ceil_trip_${i}` }))
    expect((await sync(cookie, { trips })).status).toBe(200)
  })

  it('400s a batch with more than 500 catches', async () => {
    const { cookie } = await createUserAndSession('too-many-catches@example.com')
    const catches = Array.from({ length: 501 }, (_, i) => catchInput({ client_id: `bulk_catch_${i}`, trip_id: undefined }))
    const res = await sync(cookie, { catches })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'sync batch too large' })
  })

  it('413s a body over 1 MiB before it is parsed', async () => {
    const { cookie, userId } = await createUserAndSession('huge-body@example.com')
    const res = await sync(cookie, { trips: [tripInput({ notes: 'x'.repeat(1024 * 1024 + 1) })] })
    expect(res.status).toBe(413)

    const rows = await env.DB.prepare('SELECT count(*) AS n FROM trips WHERE user_id = ?').bind(userId).first<{ n: number }>()
    expect(rows!.n).toBe(0)
  })
})

// Finding 4: a trip's span decides how many hours of enrichment it asks for, so an impossible
// span is a per-item error â€” the rest of the batch still syncs.
describe('POST /api/sync â€” bounded trip times', () => {
  const DAY = 24 * 3_600_000

  it('clamps a year-long trip to 48h rather than rejecting it, and enqueues 48 buckets', async () => {
    const { cookie } = await createUserAndSession('year-trip@example.com')
    const started = Date.now() - 365 * DAY
    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    try {
      const res = await sync(cookie, {
        trips: [tripInput({ client_id: 'year_trip', started_at: started, ended_at: Date.now() })],
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { trips: { ended_at: number }[]; errors: unknown[] }
      expect(body.errors).toEqual([])
      expect(body.trips[0]!.ended_at).toBe(started + 48 * 3_600_000)

      const row = await env.DB.prepare('SELECT ended_at FROM trips WHERE client_id = ?')
        .bind('year_trip').first<{ ended_at: number }>()
      expect(row!.ended_at).toBe(started + 48 * 3_600_000)

      const jobs = send.mock.calls.map(([job]) => job).filter((job) => job.type === 'trip_hours')
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.hour_buckets).toHaveLength(48)
    } finally { send.mockRestore() }
  })

  it('a catch referencing a clamped trip by client_id still syncs (never stranded)', async () => {
    const { cookie } = await createUserAndSession('clamped-with-catch@example.com')
    const started = Date.now() - 10 * DAY
    const body = (await (await sync(cookie, {
      trips: [tripInput({ client_id: 'long_trip', started_at: started, ended_at: Date.now() })],
      catches: [catchInput({ trip_id: 'long_trip', caught_at: started + 3_600_000 })],
    })).json()) as { trips: { id: string }[]; catches: { trip_id: string }[]; errors: unknown[] }
    expect(body.errors).toEqual([])
    expect(body.catches).toHaveLength(1)
    expect(body.catches[0]!.trip_id).toBe(body.trips[0]!.id)
  })

  it('rejects ended_at before started_at', async () => {
    const { cookie } = await createUserAndSession('backwards-trip@example.com')
    const started = Date.now() - 2 * 3_600_000
    const body = (await (await sync(cookie, {
      trips: [tripInput({ client_id: 'backwards', started_at: started, ended_at: started - 1000 })],
    })).json()) as { trips: unknown[]; errors: { message: string }[] }
    expect(body.trips).toEqual([])
    expect(body.errors[0]!.message).toContain('ended_at is before started_at')
  })

  it('rejects a started_at more than 24h in the future', async () => {
    const { cookie } = await createUserAndSession('future-trip@example.com')
    const body = (await (await sync(cookie, {
      trips: [tripInput({ client_id: 'future', started_at: Date.now() + 40 * DAY })],
    })).json()) as { errors: { message: string }[] }
    expect(body.errors[0]!.message).toContain('in the future')
  })

  it('rejects a started_at before the year 2000', async () => {
    const { cookie } = await createUserAndSession('ancient-trip@example.com')
    const body = (await (await sync(cookie, {
      trips: [tripInput({ client_id: 'ancient', started_at: 0 })],
    })).json()) as { errors: { message: string }[] }
    expect(body.errors[0]!.message).toContain('2000-01-01')
  })

  it('rejects a caught_at far in the future, so no orphan trip is minted around it', async () => {
    const { cookie, userId } = await createUserAndSession('future-catch@example.com')
    const body = (await (await sync(cookie, {
      catches: [catchInput({ client_id: 'future_catch', trip_id: undefined, caught_at: Date.now() + 400 * DAY })],
    })).json()) as { trips: unknown[]; catches: unknown[]; errors: { client_id: string }[] }
    expect(body.catches).toEqual([])
    expect(body.trips).toEqual([])
    expect(body.errors[0]!.client_id).toBe('future_catch')

    const rows = await env.DB.prepare('SELECT count(*) AS n FROM trips WHERE user_id = ?').bind(userId).first<{ n: number }>()
    expect(rows!.n).toBe(0)
  })

  it('a valid trip in the same batch still syncs alongside a rejected one', async () => {
    const { cookie } = await createUserAndSession('mixed-batch@example.com')
    const started = Date.now() - 3 * 3_600_000
    const body = (await (await sync(cookie, {
      trips: [
        tripInput({ client_id: 'good_trip', started_at: started, ended_at: started + 2 * 3_600_000 }),
        tripInput({ client_id: 'bad_trip', started_at: started, ended_at: started - 1000 }),
      ],
    })).json()) as { trips: { client_id: string }[]; errors: { client_id: string }[] }
    expect(body.trips.map((t) => t.client_id)).toEqual(['good_trip'])
    expect(body.errors.map((e) => e.client_id)).toEqual(['bad_trip'])
  })
})

// Finding 5: a lure_id the caller doesn't own must never be stored â€” the journal's join would
// otherwise read that angler's private lure name back out.
describe('POST /api/sync â€” lure ownership', () => {
  async function createLure(cookie: string, name: string): Promise<string> {
    const res = await app.request(
      '/api/lures',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name }) },
      env,
    )
    const { lure } = (await res.json()) as { lure: { id: string } }
    return lure.id
  }

  it("rejects a catch carrying another angler's lure_id, and stores nothing", async () => {
    const victim = await createUserAndSession('lure-victim@example.com')
    const attacker = await createUserAndSession('lure-attacker@example.com')
    const victimLureId = await createLure(victim.cookie, 'Secret Confidence Bait')

    const res = await sync(attacker.cookie, {
      trips: [tripInput()],
      catches: [catchInput({ client_id: 'cat_foreign_lure', lure_id: victimLureId })],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { catches: unknown[]; errors: { client_id: string; message: string }[] }
    expect(body.catches).toEqual([])
    expect(body.errors[0]!.client_id).toBe('cat_foreign_lure')
    expect(body.errors[0]!.message).toContain(victimLureId)

    const row = await env.DB.prepare('SELECT id FROM catches WHERE client_id = ?').bind('cat_foreign_lure').first()
    expect(row).toBeNull()
  })

  it('rejects a lure_id that exists for nobody', async () => {
    const { cookie } = await createUserAndSession('lure-ghost@example.com')
    const body = (await (await sync(cookie, {
      trips: [tripInput()],
      catches: [catchInput({ client_id: 'cat_ghost_lure', lure_id: 'lur_nonexistent' })],
    })).json()) as { catches: unknown[]; errors: { client_id: string }[] }
    expect(body.catches).toEqual([])
    expect(body.errors[0]!.client_id).toBe('cat_ghost_lure')
  })

  it("accepts the caller's own lure", async () => {
    const { cookie } = await createUserAndSession('lure-owner@example.com')
    const lureId = await createLure(cookie, 'War Eagle Spinnerbait')
    const body = (await (await sync(cookie, {
      trips: [tripInput()],
      catches: [catchInput({ lure_id: lureId })],
    })).json()) as { catches: { lure_id: string | null }[]; errors: unknown[] }
    expect(body.errors).toEqual([])
    expect(body.catches[0]!.lure_id).toBe(lureId)
  })
})

// Finding 4, per-account half: the input caps bound one request; this bounds the account across
// requests, so a client can't turn a stream of small legal batches into unbounded outbound work.
describe('POST /api/sync â€” per-account enrichment budget', () => {
  async function fillDispatches(userId: string, count: number, createdAt: number) {
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
       INSERT INTO enrichment_dispatches (job_key, user_id, created_at)
       SELECT 'filler:' || ? || ':' || n, ?, ? FROM seq`,
    )
      .bind(count, userId, userId, createdAt)
      .run()
  }

  it('stops dispatching once the rolling-day budget is spent, but still stores the catch', async () => {
    const { cookie, userId } = await createUserAndSession('budget-spent@example.com')
    await fillDispatches(userId, MAX_DISPATCHES_PER_WINDOW, Date.now() - 60_000)

    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    try {
      const res = await sync(cookie, { trips: [tripInput()], catches: [catchInput()] })
      expect(res.status).toBe(200)
      expect(send).not.toHaveBeenCalled()

      // Capture is never blocked by enrichment (packet Â§06) â€” the row is there.
      const row = await env.DB.prepare('SELECT id FROM catches WHERE client_id = ?').bind('cat_client_1').first()
      expect(row).not.toBeNull()
      // No receipt for a skipped job, so a later sync re-dispatches it.
      const receipt = await env.DB.prepare("SELECT job_key FROM enrichment_dispatches WHERE job_key LIKE 'catch:%'").first()
      expect(receipt).toBeNull()
    } finally { send.mockRestore() }
  })

  it('ignores dispatches older than the rolling window', async () => {
    const { cookie, userId } = await createUserAndSession('budget-rolled@example.com')
    await fillDispatches(userId, MAX_DISPATCHES_PER_WINDOW, Date.now() - DISPATCH_WINDOW_MS - 60_000)

    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    try {
      expect((await sync(cookie, { trips: [tripInput()], catches: [catchInput()] })).status).toBe(200)
      expect(send).toHaveBeenCalled()
    } finally { send.mockRestore() }
  })
})
