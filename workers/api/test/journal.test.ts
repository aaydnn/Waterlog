import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import app from '../src/index'
import { generateToken, sha256Hex } from '../src/lib/crypto'
import { SESSION_TTL_MS } from '../src/lib/sessions'

const HOUR = 60 * 60 * 1000
const JUNE_1 = Date.UTC(2026, 5, 1, 12, 0, 0)
const JULY_4 = Date.UTC(2026, 6, 4, 12, 0, 0)

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

async function insertWater(userId: string, id: string, name: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO water_bodies (id, user_id, name, kind, centroid_lat, centroid_lng, is_home, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)',
  )
    .bind(id, userId, name, 'reservoir', 36.3572, -83.6848)
    .run()
}

async function insertTrip(
  userId: string,
  id: string,
  waterBodyId: string | null,
  startedAt: number,
  endedAt: number | null,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO trips (id, user_id, water_body_id, started_at, ended_at, auto_created, planned, created_at, updated_at, client_id) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)',
  )
    .bind(id, userId, waterBodyId, startedAt, endedAt, startedAt, startedAt, `client_${id}`)
    .run()
}

async function insertLure(userId: string, id: string, name: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO lures (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
  )
    .bind(id, userId, name)
    .run()
}

async function insertCatch(
  userId: string,
  id: string,
  tripId: string,
  species: string,
  caughtAt: number,
  lureId: string | null = null,
  photoKey: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO catches (id, user_id, trip_id, lure_id, species, caught_at, photo_key, client_id, enrich_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(id, userId, tripId, lureId, species, caughtAt, photoKey, `client_${id}`, caughtAt, caughtAt)
    .run()
}

interface Seeded {
  userId: string
  cookie: string
}

/** One angler: two waters, three trips (one of them a skunk), six catches. */
async function seedAngler(email: string): Promise<Seeded> {
  const { userId, cookie } = await createUserAndSession(email)
  await insertWater(userId, `wb_norris_${userId}`, 'Norris Lake')
  await insertWater(userId, `wb_oliphant_${userId}`, 'Lake Oliphant')
  await insertLure(userId, `lur_spin_${userId}`, 'War Eagle Spinnerbait')

  await insertTrip(userId, `trp_1_${userId}`, `wb_norris_${userId}`, JUNE_1, JUNE_1 + 4 * HOUR)
  await insertTrip(userId, `trp_2_${userId}`, `wb_oliphant_${userId}`, JULY_4, JULY_4 + 2 * HOUR)
  await insertTrip(userId, `trp_skunk_${userId}`, `wb_norris_${userId}`, JULY_4 + 5 * HOUR, JULY_4 + 6 * HOUR)

  await insertCatch(userId, `cat_1_${userId}`, `trp_1_${userId}`, 'largemouth_bass', JUNE_1 + HOUR, `lur_spin_${userId}`)
  await insertCatch(userId, `cat_2_${userId}`, `trp_1_${userId}`, 'largemouth_bass', JUNE_1 + 2 * HOUR)
  await insertCatch(userId, `cat_3_${userId}`, `trp_1_${userId}`, 'bluegill', JUNE_1 + 3 * HOUR)
  await insertCatch(userId, `cat_4_${userId}`, `trp_2_${userId}`, 'largemouth_bass', JULY_4 + HOUR, `lur_spin_${userId}`)
  await insertCatch(userId, `cat_5_${userId}`, `trp_2_${userId}`, 'crappie', JULY_4 + 90 * 60 * 1000)
  await insertCatch(
    userId,
    `cat_6_${userId}`,
    `trp_2_${userId}`,
    'crappie',
    JULY_4 + 100 * 60 * 1000,
    null,
    `photos/${userId}/fish.jpg`,
  )

  return { userId, cookie }
}

function get(path: string, cookie: string) {
  return app.request(path, { headers: { cookie } }, env)
}

interface JournalBody {
  entries: Array<{
    id: string
    species: string
    caught_at: number
    lure_name: string | null
    water_body_name: string | null
  }>
  next_cursor: string | null
}

describe('GET /api/journal', () => {
  let angler: Seeded

  beforeEach(async () => {
    angler = await seedAngler(`journal-${crypto.randomUUID()}@example.com`)
  })

  it('401s without a session', async () => {
    expect((await app.request('/api/journal', {}, env)).status).toBe(401)
  })

  it('returns catches newest first, with the lure and water names a card shows', async () => {
    const res = await get('/api/journal', angler.cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as JournalBody

    expect(body.entries).toHaveLength(6)
    expect(body.entries[0]!.caught_at).toBeGreaterThan(body.entries[5]!.caught_at)
    expect(body.entries[0]!.water_body_name).toBe('Lake Oliphant')
    expect(body.entries.find((e) => e.id.startsWith('cat_1'))!.lure_name).toBe('War Eagle Spinnerbait')
    expect(body.entries.find((e) => e.id.startsWith('cat_2'))!.lure_name).toBeNull()
    expect(body.next_cursor).toBeNull()
  })

  it("never leaks another angler's catches", async () => {
    const other = await seedAngler(`other-${crypto.randomUUID()}@example.com`)
    const body = (await (await get('/api/journal', other.cookie)).json()) as JournalBody
    expect(body.entries.every((e) => e.id.endsWith(other.userId))).toBe(true)
  })

  it('filters by species, water and lure', async () => {
    const bySpecies = (await (await get('/api/journal?species=crappie', angler.cookie)).json()) as JournalBody
    expect(bySpecies.entries.map((e) => e.species)).toEqual(['crappie', 'crappie'])

    const byWater = (await (
      await get(`/api/journal?water_body_id=wb_norris_${angler.userId}`, angler.cookie)
    ).json()) as JournalBody
    expect(byWater.entries).toHaveLength(3)
    expect(byWater.entries.every((e) => e.water_body_name === 'Norris Lake')).toBe(true)

    const byLure = (await (
      await get(`/api/journal?lure_id=lur_spin_${angler.userId}`, angler.cookie)
    ).json()) as JournalBody
    expect(byLure.entries).toHaveLength(2)
  })

  it('filters by an inclusive date range', async () => {
    const juneOnly = (await (
      await get(`/api/journal?from=${JUNE_1}&to=${JUNE_1 + 3 * HOUR}`, angler.cookie)
    ).json()) as JournalBody
    expect(juneOnly.entries).toHaveLength(3)
    // `to` is inclusive: the catch exactly on the bound is in.
    expect(juneOnly.entries[0]!.caught_at).toBe(JUNE_1 + 3 * HOUR)
  })

  it('pages with a keyset cursor, without repeating or skipping a row', async () => {
    const first = (await (await get('/api/journal?limit=4', angler.cookie)).json()) as JournalBody
    expect(first.entries).toHaveLength(4)
    expect(first.next_cursor).not.toBeNull()

    const second = (await (
      await get(`/api/journal?limit=4&cursor=${encodeURIComponent(first.next_cursor!)}`, angler.cookie)
    ).json()) as JournalBody
    expect(second.entries).toHaveLength(2)
    expect(second.next_cursor).toBeNull()

    const ids = [...first.entries, ...second.entries].map((e) => e.id)
    expect(new Set(ids).size).toBe(6)
  })

  it('400s on a nonsense limit rather than guessing one', async () => {
    expect((await get('/api/journal?limit=0', angler.cookie)).status).toBe(400)
    expect((await get('/api/journal?limit=500', angler.cookie)).status).toBe(400)
  })
})

describe('GET /api/journal/:id', () => {
  it('returns the catch with its trip, water, lure and conditions', async () => {
    const angler = await seedAngler(`detail-${crypto.randomUUID()}@example.com`)
    await env.DB.prepare(
      `INSERT INTO conditions (id, user_id, catch_id, air_temp_c, pressure_hpa, pressure_trend, water_temp_c, water_temp_source, created_at)
       VALUES (?, ?, ?, 24.5, 1013.2, 'falling', 21.1, 'measured', 0)`,
    )
      .bind(`cnd_${angler.userId}`, angler.userId, `cat_1_${angler.userId}`)
      .run()

    const res = await get(`/api/journal/cat_1_${angler.userId}`, angler.cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      catch: { species: string }
      trip: { id: string } | null
      water_body: { name: string } | null
      lure: { name: string } | null
      conditions: { pressure_trend: string; water_temp_source: string } | null
    }

    expect(body.catch.species).toBe('largemouth_bass')
    expect(body.trip!.id).toBe(`trp_1_${angler.userId}`)
    expect(body.water_body!.name).toBe('Norris Lake')
    expect(body.lure!.name).toBe('War Eagle Spinnerbait')
    expect(body.conditions!.pressure_trend).toBe('falling')
    expect(body.conditions!.water_temp_source).toBe('measured')
  })

  it('nulls the parts a catch does not have, rather than 404ing the whole detail', async () => {
    const angler = await seedAngler(`sparse-${crypto.randomUUID()}@example.com`)
    const res = await get(`/api/journal/cat_2_${angler.userId}`, angler.cookie)
    const body = (await res.json()) as { lure: unknown; conditions: unknown; water_body: { name: string } }

    expect(res.status).toBe(200)
    expect(body.lure).toBeNull()
    expect(body.conditions).toBeNull() // enrichment hasn't run in this test
    expect(body.water_body.name).toBe('Norris Lake')
  })

  it("404s on another angler's catch", async () => {
    const mine = await seedAngler(`mine-${crypto.randomUUID()}@example.com`)
    const theirs = await seedAngler(`theirs-${crypto.randomUUID()}@example.com`)
    expect((await get(`/api/journal/cat_1_${theirs.userId}`, mine.cookie)).status).toBe(404)
  })
})

describe('GET /api/stats', () => {
  it('reconciles totals and breakdowns with the raw rows', async () => {
    const angler = await seedAngler(`stats-${crypto.randomUUID()}@example.com`)
    const res = await get('/api/stats', angler.cookie)
    expect(res.status).toBe(200)
    const stats = (await res.json()) as {
      totals: {
        catches: number
        trips: number
        hours_on_water: number
        skunked_trips: number
        species: number
        waters: number
      }
      by_species: Array<{ species: string; catches: number }>
      by_month: Array<{ month: string; catches: number; trips: number }>
      by_water: Array<{ water_body_name: string | null; catches: number; trips: number }>
    }

    // 6 catches over 3 trips (4h + 2h + 1h), one of which caught nothing.
    expect(stats.totals).toEqual({
      catches: 6,
      trips: 3,
      hours_on_water: 7,
      skunked_trips: 1,
      species: 3, // largemouth bass, crappie, bluegill
      waters: 2,
    })

    expect(stats.by_species).toEqual([
      { species: 'largemouth_bass', catches: 3 },
      { species: 'crappie', catches: 2 },
      { species: 'bluegill', catches: 1 },
    ])

    // June: one trip, three catches. July: two trips, three catches.
    expect(stats.by_month).toEqual([
      { month: '2026-07', catches: 3, trips: 2 },
      { month: '2026-06', catches: 3, trips: 1 },
    ])

    // The skunk trip is counted on Norris, and contributes no catches.
    expect(stats.by_water).toEqual([
      { water_body_id: `wb_norris_${angler.userId}`, water_body_name: 'Norris Lake', catches: 3, trips: 2 },
      { water_body_id: `wb_oliphant_${angler.userId}`, water_body_name: 'Lake Oliphant', catches: 3, trips: 1 },
    ])
  })

  it('counts a trip with no water in its own bucket', async () => {
    const { userId, cookie } = await createUserAndSession(`nowater-${crypto.randomUUID()}@example.com`)
    await insertTrip(userId, `trp_orphan_${userId}`, null, JUNE_1, JUNE_1 + HOUR)
    await insertCatch(userId, `cat_orphan_${userId}`, `trp_orphan_${userId}`, 'bluegill', JUNE_1 + 10)

    const stats = (await (await get('/api/stats', cookie)).json()) as {
      by_water: Array<{ water_body_id: string | null; water_body_name: string | null; catches: number }>
      totals: { waters: number }
    }
    expect(stats.totals.waters).toBe(0)
    expect(stats.by_water).toEqual([{ water_body_id: null, water_body_name: null, catches: 1, trips: 1 }])
  })

  it('is all zeroes for an angler who has logged nothing', async () => {
    const { cookie } = await createUserAndSession(`empty-${crypto.randomUUID()}@example.com`)
    const stats = (await (await get('/api/stats', cookie)).json()) as {
      totals: { catches: number; trips: number; hours_on_water: number; skunked_trips: number }
      by_species: unknown[]
      by_month: unknown[]
      by_water: unknown[]
    }

    expect(stats.totals.catches).toBe(0)
    expect(stats.totals.hours_on_water).toBe(0)
    expect(stats.totals.skunked_trips).toBe(0)
    expect(stats.by_species).toEqual([])
    expect(stats.by_month).toEqual([])
    expect(stats.by_water).toEqual([])
  })

  it('counts an open trip in trips but not in hours on water', async () => {
    const { userId, cookie } = await createUserAndSession(`open-${crypto.randomUUID()}@example.com`)
    await insertTrip(userId, `trp_open_${userId}`, null, JUNE_1, null)

    const stats = (await (await get('/api/stats', cookie)).json()) as {
      totals: { trips: number; hours_on_water: number; skunked_trips: number }
    }
    expect(stats.totals.trips).toBe(1)
    expect(stats.totals.hours_on_water).toBe(0)
    // An open trip hasn't failed to catch anything yet — it is still fishing.
    expect(stats.totals.skunked_trips).toBe(0)
  })
})

describe('GET /api/photos/:key', () => {
  it('serves the uploader their own photo, and 404s everyone else', async () => {
    const mine = await createUserAndSession(`photo-${crypto.randomUUID()}@example.com`)
    const theirs = await createUserAndSession(`photo2-${crypto.randomUUID()}@example.com`)

    const upload = await app.request(
      '/api/photos',
      {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg', 'content-length': '4', cookie: mine.cookie },
        body: new Uint8Array([1, 2, 3, 4]),
      },
      env,
    )
    const { photo_key } = (await upload.json()) as { photo_key: string }

    const ok = await get(`/api/photos/${photo_key}`, mine.cookie)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))

    expect((await get(`/api/photos/${photo_key}`, theirs.cookie)).status).toBe(404)
    expect((await app.request(`/api/photos/${photo_key}`, {}, env)).status).toBe(401)
  })

  it('404s a key that does not exist', async () => {
    const { userId, cookie } = await createUserAndSession(`nophoto-${crypto.randomUUID()}@example.com`)
    expect((await get(`/api/photos/photos/${userId}/missing.jpg`, cookie)).status).toBe(404)
  })
})
