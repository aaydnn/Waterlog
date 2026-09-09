import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { enrichCatch, enrichTripHours } from '../src/lib/conditions'
import { readingFeature, seriesFeature, usgsPage } from './usgs-fixtures'

const HOUR_MS = 60 * 60 * 1000

async function seedUser(id: string): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES (?, ?, 'imperial', 'free', ?, ?)",
  )
    .bind(id, `${id}@example.com`, now, now)
    .run()
}

async function seedTrip(
  id: string,
  userId: string,
  startedAt: number,
  endedAt: number | null,
  waterBodyId: string | null = null,
): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO trips (id, user_id, water_body_id, started_at, ended_at, auto_created, planned, notes, created_at, updated_at, deleted_at, client_id)
     VALUES (?, ?, ?, ?, ?, 0, 1, NULL, ?, ?, NULL, NULL)`,
  )
    .bind(id, userId, waterBodyId, startedAt, endedAt, now, now)
    .run()
}

async function seedWaterBody(
  id: string,
  userId: string,
  centroidLat: number | null,
  centroidLng: number | null,
  gaugeId: string | null = null,
): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO water_bodies (id, user_id, name, kind, centroid_lat, centroid_lng, usgs_gauge_id, is_home, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'Test Lake', 'lake', ?, ?, ?, 0, ?, ?, NULL)`,
  )
    .bind(id, userId, centroidLat, centroidLng, gaugeId, now, now)
    .run()
}

async function seedCatch(
  id: string,
  userId: string,
  tripId: string,
  caughtAt: number,
  lat: number | null,
  lng: number | null,
): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO catches (id, user_id, trip_id, lure_id, species, caught_at, lat, lng, photo_key, length_mm, weight_g, depth_m, released, notes, client_id, enrich_status, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, NULL, 'largemouth_bass', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, 'pending', ?, ?, NULL)`,
  )
    .bind(id, userId, tripId, caughtAt, lat, lng, `client_${id}`, now, now)
    .run()
}

function weatherSeries(fromMs: number, toMs: number) {
  const time: string[] = []
  const temperature_2m: number[] = []
  const cloud_cover: number[] = []
  const wind_speed_10m: number[] = []
  const precipitation: number[] = []
  const surface_pressure: number[] = []
  for (let t = fromMs; t <= toMs; t += HOUR_MS) {
    time.push(new Date(t).toISOString().slice(0, 16))
    temperature_2m.push(22)
    cloud_cover.push(40)
    wind_speed_10m.push(10)
    precipitation.push(0)
    surface_pressure.push(1013)
  }
  return { hourly: { time, temperature_2m, cloud_cover, wind_speed_10m, precipitation, surface_pressure } }
}

function gaugeReadingJson(atMs: number) {
  return usgsPage([readingFeature('00010', '18.5', atMs), readingFeature('00060', '100', atMs)])
}

function routedFetch(opts: { weatherFrom: number; weatherTo: number; gaugeReadingAt?: number }) {
  return vi.fn(async (url: string) => {
    if (url.includes('open-meteo')) {
      return { ok: true, json: async () => weatherSeries(opts.weatherFrom, opts.weatherTo) } as unknown as Response
    }
    if (url.includes('/time-series-metadata/items')) {
      return { ok: true, json: async () => usgsPage() } as unknown as Response
    }
    if (url.includes('/continuous/items')) {
      const body = opts.gaugeReadingAt != null ? gaugeReadingJson(opts.gaugeReadingAt) : usgsPage()
      return { ok: true, json: async () => body } as unknown as Response
    }
    throw new Error(`unexpected fetch url: ${url}`)
  }) as unknown as typeof fetch
}

describe('enrichCatch', () => {
  it('caches a modern station ID and sends the key only to USGS for catches and trip hours', async () => {
    const at = Date.UTC(2026, 5, 1, 14)
    await seedUser('usr_modern')
    await seedWaterBody('wb_modern', 'usr_modern', 36.165, -86.785)
    await seedTrip('trp_modern', 'usr_modern', at, at + HOUR_MS, 'wb_modern')
    await seedCatch('cat_modern', 'usr_modern', 'trp_modern', at, 36.16, -86.78)
    const fetchFn = vi.fn(async (url: string) => {
      const body = url.includes('open-meteo') ? weatherSeries(at - 6 * HOUR_MS, at)
        : url.includes('/time-series-metadata/') ? usgsPage([seriesFeature()]) : gaugeReadingJson(at)
      return { ok: true, json: async () => body } as Response
    })
    expect(await enrichCatch(env.DB, fetchFn as typeof fetch, 'cat_modern', 'test-key')).toBe('done')
    expect(await enrichTripHours(env.DB, fetchFn as typeof fetch, 'trp_modern', [Math.floor(at / HOUR_MS)], 'test-key')).toBe('done')
    const wb = await env.DB.prepare('SELECT usgs_gauge_id FROM water_bodies WHERE id = ?').bind('wb_modern').first()
    expect(wb!.usgs_gauge_id).toBe('USGS-03431600')
    const calls = vi.mocked(fetchFn as typeof fetch).mock.calls
    expect(calls.filter(([url]) => String(url).includes('/time-series-metadata/'))).toHaveLength(1)
    for (const [url, init] of calls) {
      if (String(url).includes('open-meteo')) expect(init).toBeUndefined()
      else expect(init?.headers).toMatchObject({ 'X-Api-Key': 'test-key' })
    }
  })

  it('never uses another owner\'s water-body coordinates or cached gauge', async () => {
    const at = Date.UTC(2026, 5, 1, 14)
    await seedUser('usr_private_water')
    await seedUser('usr_wrong_reference')
    await seedWaterBody('wb_private', 'usr_private_water', 36.16, -86.78, '03431600')
    await seedTrip('trp_wrong_reference', 'usr_wrong_reference', at, null, 'wb_private')
    await seedCatch('cat_wrong_reference', 'usr_wrong_reference', 'trp_wrong_reference', at, null, null)
    const fetchFn = vi.fn()
    expect(await enrichCatch(env.DB, fetchFn, 'cat_wrong_reference')).toBe('partial')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not invent stable pressure when the six-hour sample is missing', async () => {
    const at = Date.UTC(2026, 5, 1, 14)
    await seedUser('usr_gap')
    await seedTrip('trp_gap', 'usr_gap', at, null)
    await seedCatch('cat_gap', 'usr_gap', 'trp_gap', at, 36.16, -86.78)
    expect(await enrichCatch(env.DB, routedFetch({ weatherFrom: at, weatherTo: at }), 'cat_gap')).toBe('partial')
    const row = await env.DB.prepare('SELECT pressure_hpa, pressure_trend FROM conditions WHERE catch_id = ?').bind('cat_gap').first()
    expect(row).toMatchObject({ pressure_hpa: 1013, pressure_trend: null })
  })

  it('keeps a catch without coordinates valid and explicitly partial', async () => {
    const at = Date.UTC(2026, 5, 1, 14)
    await seedUser('usr_no_location')
    await seedTrip('trp_no_location', 'usr_no_location', at, null)
    await seedCatch('cat_no_location', 'usr_no_location', 'trp_no_location', at, null, null)
    const fetchFn = vi.fn()
    expect(await enrichCatch(env.DB, fetchFn, 'cat_no_location')).toBe('partial')
    expect(fetchFn).not.toHaveBeenCalled()
    const row = await env.DB.prepare('SELECT air_temp_c, moon_phase FROM conditions WHERE catch_id = ?').bind('cat_no_location').first()
    expect(row).toMatchObject({ air_temp_c: null, moon_phase: expect.any(Number) })
  })

  it('full success: weather + cached gauge both answer -> done', async () => {
    const userId = 'usr_full'
    const caughtAt = Date.UTC(2026, 5, 1, 14, 0)
    await seedUser(userId)
    await seedWaterBody('wb_full', userId, 36.165, -86.785, '03431600')
    await seedTrip('trp_full', userId, caughtAt - HOUR_MS, null, 'wb_full')
    await seedCatch('cat_full', userId, 'trp_full', caughtAt, 36.16, -86.78)

    const fetchFn = routedFetch({ weatherFrom: caughtAt - 6 * HOUR_MS, weatherTo: caughtAt, gaugeReadingAt: caughtAt })
    const status = await enrichCatch(env.DB, fetchFn, 'cat_full')
    expect(status).toBe('done')

    const row = await env.DB.prepare('SELECT * FROM conditions WHERE catch_id = ?').bind('cat_full').first<{
      air_temp_c: number
      water_temp_c: number
      pressure_trend: string
      moon_phase: number
      season: string
    }>()
    expect(row).not.toBeNull()
    expect(row!.air_temp_c).toBe(22)
    expect(row!.water_temp_c).toBe(18.5)
    expect(row!.pressure_trend).toBe('stable')
    expect(row!.moon_phase).toBeGreaterThanOrEqual(0)
    expect(row!.season).toBe('summer')

    const catchRow = await env.DB.prepare('SELECT enrich_status FROM catches WHERE id = ?')
      .bind('cat_full')
      .first<{ enrich_status: string }>()
    expect(catchRow!.enrich_status).toBe('done')
  })

  it('no gauge in range -> done, not partial: absence is permanent, not worth retrying', async () => {
    const userId = 'usr_nogauge'
    const caughtAt = Date.UTC(2026, 5, 1, 14, 0)
    await seedUser(userId)
    await seedWaterBody('wb_nogauge', userId, 36.165, -86.785, null) // no cached gauge id
    await seedTrip('trp_nogauge', userId, caughtAt - HOUR_MS, null, 'wb_nogauge')
    await seedCatch('cat_nogauge', userId, 'trp_nogauge', caughtAt, 36.16, -86.78)

    // site service returns no candidates within range
    const fetchFn = routedFetch({ weatherFrom: caughtAt - 6 * HOUR_MS, weatherTo: caughtAt })
    const status = await enrichCatch(env.DB, fetchFn, 'cat_nogauge')
    // 'partial' makes the queue retry five times. A water with no gauge within 15 km will never
    // grow one, and the founder's own waters are exactly that (ADR-0008), so this must not retry.
    expect(status).toBe('done')

    const row = await env.DB.prepare(
      'SELECT water_temp_c, water_temp_source, discharge_cms, air_temp_c, source_meta FROM conditions WHERE catch_id = ?',
    )
      .bind('cat_nogauge')
      .first<{ water_temp_c: number | null; water_temp_source: string | null; discharge_cms: number | null; air_temp_c: number; source_meta: string }>()
    expect(row!.discharge_cms).toBeNull()
    expect(row!.air_temp_c).toBe(22) // weather still succeeded independently
    // The absence is recorded rather than silently indistinguishable from a failed fetch.
    expect(JSON.parse(row!.source_meta).gauge).toBe('none-in-range')
    // With no gauge temperature, the model fills in from air temp and says so.
    expect(row!.water_temp_c).toBe(22)
    expect(row!.water_temp_source).toBe('modeled')
  })

  it("prefers the angler's own reading over the model", async () => {
    const userId = 'usr_measured'
    const caughtAt = Date.UTC(2026, 5, 1, 14, 0)
    await seedUser(userId)
    await seedTrip('trp_measured', userId, caughtAt - HOUR_MS, null, null)
    await seedCatch('cat_measured', userId, 'trp_measured', caughtAt, 36.16, -86.78)
    await env.DB.prepare('UPDATE trips SET water_temp_c = ? WHERE id = ?').bind(18.5, 'trp_measured').run()

    const fetchFn = routedFetch({ weatherFrom: caughtAt - 6 * HOUR_MS, weatherTo: caughtAt })
    expect(await enrichCatch(env.DB, fetchFn, 'cat_measured')).toBe('done')

    const row = await env.DB.prepare('SELECT water_temp_c, water_temp_source FROM conditions WHERE catch_id = ?')
      .bind('cat_measured')
      .first<{ water_temp_c: number; water_temp_source: string }>()
    // 18.5 measured, not the 22 the air-temp model would have produced.
    expect(row!.water_temp_c).toBe(18.5)
    expect(row!.water_temp_source).toBe('measured')
  })

  it('no water body at all -> done as long as weather succeeds (nothing to gauge-match)', async () => {
    const userId = 'usr_nowb'
    const caughtAt = Date.UTC(2026, 5, 1, 14, 0)
    await seedUser(userId)
    await seedTrip('trp_nowb', userId, caughtAt - HOUR_MS, null, null)
    await seedCatch('cat_nowb', userId, 'trp_nowb', caughtAt, 36.16, -86.78)

    const fetchFn = routedFetch({ weatherFrom: caughtAt - 6 * HOUR_MS, weatherTo: caughtAt })
    const status = await enrichCatch(env.DB, fetchFn, 'cat_nowb')
    expect(status).toBe('done')
  })

  it('is idempotent under redelivery: running twice yields one conditions row', async () => {
    const userId = 'usr_replay'
    const caughtAt = Date.UTC(2026, 5, 1, 14, 0)
    await seedUser(userId)
    await seedTrip('trp_replay', userId, caughtAt - HOUR_MS, null, null)
    await seedCatch('cat_replay', userId, 'trp_replay', caughtAt, 36.16, -86.78)

    const fetchFn = routedFetch({ weatherFrom: caughtAt - 6 * HOUR_MS, weatherTo: caughtAt })
    await enrichCatch(env.DB, fetchFn, 'cat_replay')
    await enrichCatch(env.DB, fetchFn, 'cat_replay')

    const count = await env.DB.prepare('SELECT count(*) AS n FROM conditions WHERE catch_id = ?')
      .bind('cat_replay')
      .first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('throws for an unknown catch id (lets the queue consumer retry)', async () => {
    const fetchFn = routedFetch({ weatherFrom: 0, weatherTo: 0 })
    await expect(enrichCatch(env.DB, fetchFn, 'does_not_exist')).rejects.toThrow()
  })
})

describe('enrichTripHours', () => {
  it('a 4.5h trip yields exactly 5 conditions rows, all trip-hour (no catch_id)', async () => {
    const userId = 'usr_backfill'
    const started = Date.UTC(2026, 5, 1, 10, 15)
    const ended = started + 4.5 * HOUR_MS
    await seedUser(userId)
    await seedWaterBody('wb_backfill', userId, 36.165, -86.785, '03431600')
    await seedTrip('trp_backfill', userId, started, ended, 'wb_backfill')

    const firstBucket = Math.floor(started / HOUR_MS)
    const hourBuckets = Array.from({ length: 5 }, (_, i) => firstBucket + i)
    const fetchFn = routedFetch({
      weatherFrom: firstBucket * HOUR_MS - 6 * HOUR_MS,
      weatherTo: (firstBucket + 4) * HOUR_MS,
      gaugeReadingAt: started + 2 * HOUR_MS,
    })

    const status = await enrichTripHours(env.DB, fetchFn, 'trp_backfill', hourBuckets)
    expect(status).toBe('done')

    const rows = await env.DB.prepare(
      'SELECT hour_bucket, catch_id FROM conditions WHERE trip_id = ? ORDER BY hour_bucket',
    )
      .bind('trp_backfill')
      .all<{ hour_bucket: number; catch_id: string | null }>()
    expect(rows.results).toHaveLength(5)
    for (const row of rows.results) expect(row.catch_id).toBeNull()
    expect(rows.results.map((r: { hour_bucket: number }) => r.hour_bucket)).toEqual(hourBuckets)
  })

  it('falls back to a catch location when the trip has no water body', async () => {
    const userId = 'usr_fallback'
    const started = Date.UTC(2026, 5, 1, 10, 0)
    const ended = started + HOUR_MS
    await seedUser(userId)
    await seedTrip('trp_fallback', userId, started, ended, null)
    await seedCatch('cat_fallback', userId, 'trp_fallback', started + 30 * 60 * 1000, 36.16, -86.78)

    const bucket = Math.floor(started / HOUR_MS)
    const fetchFn = routedFetch({ weatherFrom: bucket * HOUR_MS - 6 * HOUR_MS, weatherTo: bucket * HOUR_MS })
    const status = await enrichTripHours(env.DB, fetchFn, 'trp_fallback', [bucket])
    expect(status).toBe('done')

    const row = await env.DB.prepare('SELECT air_temp_c FROM conditions WHERE trip_id = ? AND hour_bucket = ?')
      .bind('trp_fallback', bucket)
      .first<{ air_temp_c: number }>()
    expect(row!.air_temp_c).toBe(22)
  })

  it('is idempotent under redelivery: running twice yields the same 5 rows, not 10', async () => {
    const userId = 'usr_backfill_replay'
    const started = Date.UTC(2026, 5, 1, 10, 0)
    const ended = started + 4 * HOUR_MS
    await seedUser(userId)
    await seedTrip('trp_backfill_replay', userId, started, ended, null)

    const firstBucket = Math.floor(started / HOUR_MS)
    const hourBuckets = Array.from({ length: 4 }, (_, i) => firstBucket + i)
    const fetchFn = routedFetch({ weatherFrom: 0, weatherTo: 0 })

    await enrichTripHours(env.DB, fetchFn, 'trp_backfill_replay', hourBuckets)
    await enrichTripHours(env.DB, fetchFn, 'trp_backfill_replay', hourBuckets)

    const count = await env.DB.prepare('SELECT count(*) AS n FROM conditions WHERE trip_id = ?')
      .bind('trp_backfill_replay')
      .first<{ n: number }>()
    expect(count!.n).toBe(4)
  })
})

describe('gauge matching is anchored to the water, not the catch', () => {
  /** Records the bbox each gauge-search request was made with, so a test can prove *where* the
   * search happened rather than only what it returned. */
  function bboxRecordingFetch(at: number) {
    const bboxes: string[] = []
    const fetchFn = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('open-meteo')) {
        return { ok: true, json: async () => weatherSeries(at - 6 * HOUR_MS, at) } as unknown as Response
      }
      if (u.includes('/time-series-metadata/')) {
        const bbox = new URL(u).searchParams.get('bbox')
        if (bbox) bboxes.push(bbox)
        return { ok: true, json: async () => usgsPage([seriesFeature()]) } as unknown as Response
      }
      return { ok: true, json: async () => gaugeReadingJson(at) } as unknown as Response
    })
    return { fetchFn: fetchFn as unknown as typeof fetch, bboxes }
  }

  it("searches around the lake's centroid even when the catch was logged 200 km away", async () => {
    const at = Date.UTC(2026, 5, 1, 14)
    await seedUser('usr_anchor')
    // Norris Lake's centroid, and a catch logged from home in Nashville.
    await seedWaterBody('wb_anchor', 'usr_anchor', 36.3572, -83.6848)
    await seedTrip('trp_anchor', 'usr_anchor', at, at + HOUR_MS, 'wb_anchor')
    await seedCatch('cat_anchor', 'usr_anchor', 'trp_anchor', at, 36.1627, -86.7816)
    const { fetchFn, bboxes } = bboxRecordingFetch(at)

    await enrichCatch(env.DB, fetchFn, 'cat_anchor', 'test-key')

    expect(bboxes).toHaveLength(1)
    const [west, south, east, north] = bboxes[0]!.split(',').map(Number)
    // The box is around the lake (-83.68), not around Nashville (-86.78).
    expect(west!).toBeGreaterThan(-84)
    expect(east!).toBeLessThan(-83)
    expect(south!).toBeLessThan(36.3572)
    expect(north!).toBeGreaterThan(36.3572)
  })

  it('still uses the catch position when the water has no centroid to anchor to', async () => {
    const at = Date.UTC(2026, 5, 1, 14)
    await seedUser('usr_nocentroid')
    await seedWaterBody('wb_nocentroid', 'usr_nocentroid', null, null)
    await seedTrip('trp_nocentroid', 'usr_nocentroid', at, at + HOUR_MS, 'wb_nocentroid')
    await seedCatch('cat_nocentroid', 'usr_nocentroid', 'trp_nocentroid', at, 36.1627, -86.7816)
    const { fetchFn, bboxes } = bboxRecordingFetch(at)

    await enrichCatch(env.DB, fetchFn, 'cat_nocentroid', 'test-key')

    const [west, , east] = bboxes[0]!.split(',').map(Number)
    expect(west!).toBeLessThan(-86.7)
    expect(east!).toBeGreaterThan(-86.8)
  })

  it('does not pin the water to a gauge found from a catch position', async () => {
    const at = Date.UTC(2026, 5, 1, 14)
    await seedUser('usr_nopin')
    await seedWaterBody('wb_nopin', 'usr_nopin', null, null)
    await seedTrip('trp_nopin', 'usr_nopin', at, at + HOUR_MS, 'wb_nopin')
    await seedCatch('cat_nopin', 'usr_nopin', 'trp_nopin', at, 36.1627, -86.7816)
    const { fetchFn } = bboxRecordingFetch(at)

    await enrichCatch(env.DB, fetchFn, 'cat_nopin', 'test-key')

    // The reading is used for this catch, but a gauge near one catch is not a fact about the
    // water — remembering it is how a single mislocated catch poisons every later one.
    const wb = await env.DB.prepare('SELECT usgs_gauge_id FROM water_bodies WHERE id = ?').bind('wb_nopin').first()
    expect(wb!.usgs_gauge_id).toBeNull()
    const conditions = await env.DB.prepare('SELECT discharge_cms FROM conditions WHERE catch_id = ?')
      .bind('cat_nopin')
      .first<{ discharge_cms: number | null }>()
    expect(conditions!.discharge_cms).not.toBeNull()
  })
})
