import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

const HOUR_MS = 60 * 60 * 1000
afterEach(() => vi.unstubAllGlobals())

function fakeMessage(body: unknown, attempts = 1) {
  return {
    id: 'm1',
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function batchOf(messages: ReturnType<typeof fakeMessage>[]): MessageBatch<unknown> {
  return { queue: 'waterlog-enrich', messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>
}

async function seedUserTripCatch(userId: string, caughtAt: number): Promise<{ tripId: string; catchId: string }> {
  const now = Date.now()
  await env.DB.prepare(
    "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES (?, ?, 'imperial', 'free', ?, ?)",
  )
    .bind(userId, `${userId}@example.com`, now, now)
    .run()
  const tripId = `trp_${userId}`
  await env.DB.prepare(
    `INSERT INTO trips (id, user_id, water_body_id, started_at, ended_at, auto_created, planned, notes, created_at, updated_at, deleted_at, client_id)
     VALUES (?, ?, NULL, ?, ?, 0, 1, NULL, ?, ?, NULL, NULL)`,
  )
    .bind(tripId, userId, caughtAt - HOUR_MS, caughtAt + HOUR_MS, now, now)
    .run()
  const catchId = `cat_${userId}`
  await env.DB.prepare(
    `INSERT INTO catches (id, user_id, trip_id, lure_id, species, caught_at, lat, lng, photo_key, length_mm, weight_g, depth_m, released, notes, client_id, enrich_status, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, NULL, 'largemouth_bass', ?, 36.16, -86.78, NULL, NULL, NULL, NULL, NULL, NULL, ?, 'pending', ?, ?, NULL)`,
  )
    .bind(catchId, userId, tripId, caughtAt, `client_${catchId}`, now, now)
    .run()
  return { tripId, catchId }
}

function stubOkFetch() {
  return vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('open-meteo')) return { ok: true, json: async () => ({ hourly: {
        time: Array.from({ length: 7 }, (_, i) => `2026-06-01T${String(6 + i).padStart(2, '0')}:00`),
        temperature_2m: Array(7).fill(22), cloud_cover: Array(7).fill(40),
        wind_speed_10m: Array(7).fill(10), precipitation: Array(7).fill(0), surface_pressure: Array(7).fill(1013),
      } }) } as unknown as Response
      return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [], links: [] }) } as unknown as Response
    }),
  )
}

describe('enrich queue consumer', () => {
  it('passes the worker secret to USGS without attaching it to weather requests', async () => {
    stubOkFetch()
    const { tripId, catchId } = await seedUserTripCatch('usr_key', Date.UTC(2026, 5, 1, 12))
    await env.DB.prepare('INSERT INTO water_bodies (id, user_id, name, centroid_lat, centroid_lng, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('wb_key', 'usr_key', 'Test', 36.16, -86.78, Date.now(), Date.now()).run()
    await env.DB.prepare('UPDATE trips SET water_body_id = ? WHERE id = ?').bind('wb_key', tripId).run()
    await worker.queue(batchOf([fakeMessage({ type: 'catch', catch_id: catchId })]), { DB: env.DB, USGS_API_KEY: 'test-key' })
    const calls = vi.mocked(fetch).mock.calls
    const usgsCalls = calls.filter(([url]) => String(url).includes('api.waterdata.usgs.gov'))
    expect(usgsCalls).toHaveLength(1)
    expect(usgsCalls[0]![1]?.headers).toMatchObject({ 'X-Api-Key': 'test-key' })
    for (const [url, init] of calls) {
      if (String(url).includes('open-meteo')) expect(init).toBeUndefined()
    }
  })

  it('retries incomplete trip-hour backfill while preserving every exposure row', async () => {
    const { tripId } = await seedUserTripCatch('usr_q4', Date.UTC(2026, 5, 1, 12))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('source unavailable')))
    const first = Math.floor(Date.UTC(2026, 5, 1, 12) / HOUR_MS)
    const job = { type: 'trip_hours', trip_id: tripId, hour_buckets: [first, first + 1] }
    const message = fakeMessage(job)
    await worker.queue(batchOf([message]), env)
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    const last = fakeMessage(job, 5)
    await worker.queue(batchOf([last]), env)
    expect(last.ack).toHaveBeenCalledOnce()
    expect(last.retry).not.toHaveBeenCalled()
    const rows = await env.DB.prepare('SELECT hour_bucket FROM conditions WHERE trip_id = ?').bind(tripId).all()
    expect(rows.results).toHaveLength(2)
  })

  it('acks a valid catch job after enriching', async () => {
    stubOkFetch()
    const { catchId } = await seedUserTripCatch('usr_q1', Date.UTC(2026, 5, 1, 12))
    const message = fakeMessage({ type: 'catch', catch_id: catchId })

    await worker.queue(batchOf([message]), env)

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('acks a valid trip_hours job after enriching', async () => {
    stubOkFetch()
    const { tripId } = await seedUserTripCatch('usr_q2', Date.UTC(2026, 5, 1, 12))
    const bucket = Math.floor(Date.UTC(2026, 5, 1, 12) / HOUR_MS)
    const message = fakeMessage({ type: 'trip_hours', trip_id: tripId, hour_buckets: [bucket] })

    await worker.queue(batchOf([message]), env)

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('drops a malformed message without retrying (never a poison pill)', async () => {
    const message = fakeMessage({ type: 'not_a_real_type' })
    await worker.queue(batchOf([message]), env)
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('retries with backoff when the job throws and attempts remain', async () => {
    const message = fakeMessage({ type: 'catch', catch_id: 'does_not_exist' }, 1)
    await worker.queue(batchOf([message]), env)
    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
  })

  it('keeps partial conditions and stops after five attempts when a source is down', async () => {
    const { catchId } = await seedUserTripCatch('usr_q3', Date.UTC(2026, 5, 1, 12))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('source unavailable')))
    for (let attempt = 1; attempt <= 5; attempt++) {
      const message = fakeMessage({ type: 'catch', catch_id: catchId }, attempt)
      await worker.queue(batchOf([message]), env)
      if (attempt < 5) {
        expect(message.retry).toHaveBeenCalledWith({ delaySeconds: Math.min(30 * 2 ** (attempt - 1), 300) })
        expect(message.ack).not.toHaveBeenCalled()
      } else {
        expect(message.retry).not.toHaveBeenCalled()
        expect(message.ack).toHaveBeenCalledOnce()
      }
    }
    const row = await env.DB.prepare('SELECT enrich_status FROM catches WHERE id = ?').bind(catchId).first<{ enrich_status: string }>()
    expect(row!.enrich_status).toBe('partial')
    const conditions = await env.DB.prepare('SELECT moon_phase FROM conditions WHERE catch_id = ?').bind(catchId).all()
    expect(conditions.results).toHaveLength(1)
    expect(conditions.results[0]!.moon_phase).toEqual(expect.any(Number))
  })
})
