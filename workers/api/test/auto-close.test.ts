import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { generateToken, sha256Hex } from '../src/lib/crypto'
import { SESSION_TTL_MS } from '../src/lib/sessions'
import { MAX_TRIP_DURATION_MS, MIN_TRIP_MS, staleTripEndAt } from '../src/lib/trips'

const HOUR_MS = 60 * 60 * 1000

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

/** The sweep runs before this request's own trips are written, so a trip synced here is only
 * ever closed by a *later* request — which is exactly how it happens in the field. */
async function openStaleTrip(
  cookie: string,
  clientId: string,
  startedAt: number,
  catchesAt: number[] = [],
): Promise<string> {
  const res = await sync(cookie, {
    trips: [{ client_id: clientId, water_body_id: null, started_at: startedAt, ended_at: null, auto_created: 0, planned: 0, notes: null }],
    catches: catchesAt.map((caught_at, i) => ({
      client_id: `${clientId}_c${i}`,
      trip_id: clientId,
      lure_id: null,
      species: 'largemouth_bass',
      caught_at,
      lat: null,
      lng: null,
      photo_key: null,
      length_mm: null,
      weight_g: null,
      depth_m: null,
      released: 1,
      notes: null,
    })),
  })
  const { trips } = (await res.json()) as { trips: { id: string; client_id: string }[] }
  return trips.find((t) => t.client_id === clientId)!.id
}

function endedAtOf(tripId: string) {
  return env.DB.prepare('SELECT ended_at FROM trips WHERE id = ?').bind(tripId).first<{ ended_at: number | null }>()
}

describe('staleTripEndAt', () => {
  it('ends at the last catch when there is one', () => {
    const started = 1_780_000_000_000
    expect(staleTripEndAt(started, started + 5 * HOUR_MS)).toBe(started + 5 * HOUR_MS)
  })

  it('floors a skunked trip at an hour rather than recording zero', () => {
    const started = 1_780_000_000_000
    expect(staleTripEndAt(started, null)).toBe(started + MIN_TRIP_MS)
  })

  it('floors a trip whose only catch landed in its first minutes', () => {
    const started = 1_780_000_000_000
    expect(staleTripEndAt(started, started + 60_000)).toBe(started + MIN_TRIP_MS)
  })
})

describe('auto-close of stale trips on sync', () => {
  it('closes a forgotten trip at its last catch, not at the moment we noticed', async () => {
    const { cookie } = await createUserAndSession('stale-with-catch@example.com')
    const started = Date.now() - 5 * 24 * HOUR_MS
    const lastCatch = started + 3 * HOUR_MS
    const tripId = await openStaleTrip(cookie, 'stale_caught', started, [started + HOUR_MS, lastCatch])

    expect((await endedAtOf(tripId))!.ended_at).toBeNull()

    await sync(cookie, {})

    expect((await endedAtOf(tripId))!.ended_at).toBe(lastCatch)
  })

  it('closes a forgotten skunk at one hour, keeping it in the denominator', async () => {
    const { cookie } = await createUserAndSession('stale-skunk@example.com')
    const started = Date.now() - 5 * 24 * HOUR_MS
    const tripId = await openStaleTrip(cookie, 'stale_skunk', started)

    await sync(cookie, {})

    expect((await endedAtOf(tripId))!.ended_at).toBe(started + MIN_TRIP_MS)
  })

  it('leaves a trip inside the ceiling alone — a long skunk is still being fished', async () => {
    const { cookie } = await createUserAndSession('long-skunk@example.com')
    // Well past the 6h idle rule and with nothing caught: the exact case the client asks about
    // and the server must not answer for it.
    const started = Date.now() - 12 * HOUR_MS
    const tripId = await openStaleTrip(cookie, 'still_fishing', started)

    await sync(cookie, {})

    expect((await endedAtOf(tripId))!.ended_at).toBeNull()
  })

  it('enqueues the closed trip\'s hours exactly once, however many times it sweeps', async () => {
    const { cookie } = await createUserAndSession('stale-enrich@example.com')
    const started = Date.now() - 5 * 24 * HOUR_MS
    const tripId = await openStaleTrip(cookie, 'stale_enrich', started)

    const send = vi.spyOn(env.ENRICH_QUEUE, 'send')
    try {
      await sync(cookie, {})
      const tripHourJobs = send.mock.calls.filter(([m]) => (m as { type: string }).type === 'trip_hours')
      expect(tripHourJobs).toHaveLength(1)
      expect(tripHourJobs[0]![0]).toMatchObject({ trip_id: tripId })
      expect((tripHourJobs[0]![0] as { hour_buckets: number[] }).hour_buckets).toHaveLength(1)

      send.mockClear()
      await sync(cookie, {})
      expect(send.mock.calls.filter(([m]) => (m as { type: string }).type === 'trip_hours')).toHaveLength(0)
    } finally {
      send.mockRestore()
    }
  })

  it('is idempotent: a second sweep does not move an end time it already set', async () => {
    const { cookie } = await createUserAndSession('stale-idempotent@example.com')
    const started = Date.now() - 5 * 24 * HOUR_MS
    const tripId = await openStaleTrip(cookie, 'stale_twice', started, [started + 2 * HOUR_MS])

    await sync(cookie, {})
    const first = (await endedAtOf(tripId))!.ended_at
    await sync(cookie, {})

    expect((await endedAtOf(tripId))!.ended_at).toBe(first)
  })

  it("never touches another angler's stale trip", async () => {
    const owner = await createUserAndSession('stale-owner@example.com')
    const other = await createUserAndSession('stale-other@example.com')
    const started = Date.now() - 5 * 24 * HOUR_MS
    const tripId = await openStaleTrip(owner.cookie, 'stale_owned', started)

    await sync(other.cookie, {})

    expect((await endedAtOf(tripId))!.ended_at).toBeNull()
  })

  it('does not report the trips it closed to the client', async () => {
    const { cookie } = await createUserAndSession('stale-quiet@example.com')
    const started = Date.now() - 5 * 24 * HOUR_MS
    await openStaleTrip(cookie, 'stale_quiet', started)

    const res = await sync(cookie, {})
    const body = (await res.json()) as { trips: unknown[]; catches: unknown[]; errors: unknown[] }

    // Mirroring it by client_id would file a second local row and leave the original looking
    // active, so the sweep stays silent and the client closes its own copy.
    expect(body.trips).toEqual([])
    expect(body.errors).toEqual([])
  })

  it('closes a stale trip at the ceiling when its last catch somehow sits beyond it', async () => {
    const { cookie } = await createUserAndSession('stale-clamped@example.com')
    const started = Date.now() - 20 * 24 * HOUR_MS
    const tripId = await openStaleTrip(cookie, 'stale_clamped', started)
    // A catch written before trip times were validated — the clamp is the backstop for rows
    // that predate the guard, so it is written straight to the table.
    const beyond = started + 10 * 24 * HOUR_MS
    await env.DB.prepare(
      `INSERT INTO catches (id, user_id, trip_id, species, caught_at, released, enrich_status, created_at, updated_at, client_id)
       VALUES (?, (SELECT user_id FROM trips WHERE id = ?), ?, 'largemouth_bass', ?, 1, 'pending', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), tripId, tripId, beyond, Date.now(), Date.now(), 'stale_clamped_late')
      .run()

    await sync(cookie, {})

    expect((await endedAtOf(tripId))!.ended_at).toBe(started + MAX_TRIP_DURATION_MS)
  })
})
