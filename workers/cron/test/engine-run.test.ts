import { env } from 'cloudflare:test'
import { runEngine, type FindingRecord } from '@waterlog/pattern-engine'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import { v2ToPatternCache } from '../src/lib/v2/adapter'
import { loadEngineInput } from '../src/lib/v2/load'
import { runEngineForUser } from '../src/lib/v2/run'
import { seedAngler, type AnglerSeed } from './seed'

/**
 * The v2 engine end to end: real rows, real SQL, real D1 (ADR-0017, brief §5).
 *
 * The fixture is the same shape the v1 suite uses — one falling-pressure hour per trip carrying
 * two fish, the rest stable carrying one — so the two engines can be compared on the same history.
 */

const NOW = Date.UTC(2026, 8, 15, 8)

function hotTrips(count: number): AnglerSeed['trips'] {
  return Array.from({ length: count }, () => ({
    hours: 4,
    conditions: { pressure_trend: 'stable' as const, season: 'summer' },
    hourOverrides: { 0: { pressure_trend: 'falling' as const } },
    catches: [
      { hour: 0, color: 'chartreuse' },
      { hour: 0, color: 'chartreuse' },
      { hour: 1, color: 'white' },
    ],
  }))
}

function engineBatch(bodies: unknown[]) {
  const acks: number[] = []
  const retries: number[] = []
  const messages = bodies.map((body, i) => ({
    id: `e${i}`,
    timestamp: new Date(NOW),
    body,
    attempts: 1,
    ack: () => acks.push(i),
    retry: () => retries.push(i),
  }))
  return {
    batch: {
      queue: 'pattern-engine',
      messages,
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>,
    acks,
    retries,
  }
}

describe('the v2 engine run', () => {
  it('turns an angler history into findings that carry their own lifecycle', async () => {
    const userId = await seedAngler({ email: 'v2-round-trip@example.com', trips: hotTrips(12) })

    const outcome = await runEngineForUser(env.DB, userId, NOW)
    expect(outcome.trips).toBe(12)
    expect(outcome.hours).toBe(48)
    expect(outcome.catches).toBe(36)
    expect(outcome.empty).toBe(false)
    expect(outcome.records).toBeGreaterThan(0)

    const row = await env.DB.prepare(
      'SELECT * FROM pattern_findings WHERE user_id = ? AND key = ?',
    )
      .bind(userId, 'all::all::pressure_trend::falling')
      .first<Record<string, unknown>>()

    expect(row).not.toBeNull()
    expect(row!.scope).toBe('all')
    expect(row!.outcome).toBe('all')
    expect(row!.dimension).toBe('pressure_trend')
    expect(row!.bucket).toBe('falling')
    expect(row!.direction).toBe('positive')
    // Falling pressure carries two fish an hour against one, so it has to come out above 1 — and
    // below the raw 2.67 ratio, because ADR-0017 shrinks what it displays.
    expect(row!.multiplier as number).toBeGreaterThan(1)
    expect(row!.multiplier as number).toBeLessThan(2.67)
    expect(row!.engine_version).toBeTruthy()
    expect(row!.computed_at).toBe(NOW)

    // The record is the part that survives between runs, so it has to be readable back.
    const record = JSON.parse(row!.record_json as string) as FindingRecord
    expect(record.key).toBe('all::all::pressure_trend::falling')
    expect(record.discoveredAt).toBe(NOW)
    expect(record.history.length).toBeGreaterThan(0)
  })

  it('records the run without touching the columns v1 owns', async () => {
    const userId = await seedAngler({ email: 'v2-run-row@example.com', trips: hotTrips(12) })
    await runEngineForUser(env.DB, userId, NOW)

    const run = await env.DB.prepare('SELECT * FROM pattern_runs WHERE user_id = ?')
      .bind(userId)
      .first<Record<string, unknown>>()

    expect(run!.result_json).toBeTruthy()
    expect(run!.engine_version).toBeTruthy()
    expect(run!.computed_at).toBe(NOW)
    // The landmine: `pattern_runs` is shared, and v1's nightly sweep picks anglers by
    // `completed_at`. If a v2 run set it, v1 would think the angler was done and skip them.
    expect(run!.completed_at).toBeNull()
    expect(run!.cursor).toBeNull()
  })

  it('writes nothing an angler can see while it runs in shadow', async () => {
    const userId = await seedAngler({ email: 'v2-shadow@example.com', trips: hotTrips(12) })
    await runEngineForUser(env.DB, userId, NOW)

    const cached = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(cached!.n).toBe(0)
  })

  it('is idempotent: a second run replaces rather than duplicates, and keeps the discovery date', async () => {
    const userId = await seedAngler({ email: 'v2-idempotent@example.com', trips: hotTrips(12) })
    await runEngineForUser(env.DB, userId, NOW)

    const first = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_findings WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()

    const later = NOW + 24 * 60 * 60 * 1000
    await runEngineForUser(env.DB, userId, later)

    const second = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_findings WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(second!.n).toBe(first!.n)

    const row = await env.DB.prepare(
      'SELECT record_json, computed_at FROM pattern_findings WHERE user_id = ? AND key = ?',
    )
      .bind(userId, 'all::all::pressure_trend::falling')
      .first<{ record_json: string; computed_at: number }>()

    expect(row!.computed_at).toBe(later)
    // Same fishing, second look: the finding was discovered on the first run and must not be
    // re-dated, or every angler's history would reset to "discovered today" every night.
    const record = JSON.parse(row!.record_json) as FindingRecord
    expect(record.discoveredAt).toBe(NOW)
  })

  it('says nothing at all about an angler with too little exposure', async () => {
    const userId = await seedAngler({
      email: 'v2-thin@example.com',
      trips: [{ hours: 2, conditions: { pressure_trend: 'falling' }, catches: [{ hour: 0 }] }],
    })
    const outcome = await runEngineForUser(env.DB, userId, NOW)

    expect(outcome.empty).toBe(true)
    expect(outcome.records).toBe(0)
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_findings WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(rows!.n).toBe(0)
  })

  it('leaves an open trip out of the denominator', async () => {
    const userId = await seedAngler({
      email: 'v2-open-trip@example.com',
      trips: [...hotTrips(12), { hours: 6, open: true, conditions: {}, catches: [{ hour: 0 }] }],
    })
    const input = await loadEngineInput(env.DB, userId, NOW)
    // An open trip has no `ended_at`, so it has generated no hour buckets; counting its fish
    // against nothing would invent a rate.
    expect(input.trips).toHaveLength(12)
  })
})

describe('the v2 queue consumer', () => {
  it('computes an angler and acknowledges the message', async () => {
    const userId = await seedAngler({ email: 'v2-consumer@example.com', trips: hotTrips(12) })
    const { batch, acks, retries } = engineBatch([{ user_id: userId, trip_id: null }])

    await worker.queue(batch, env)

    expect(acks).toEqual([0])
    expect(retries).toEqual([])
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_findings WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(rows!.n).toBeGreaterThan(0)
  })

  it('drops a malformed message instead of retrying it forever', async () => {
    const { batch, acks, retries } = engineBatch([{ nope: true }])

    await worker.queue(batch, env)

    expect(acks).toEqual([0])
    expect(retries).toEqual([])
  })

  it('retries a message whose run threw', async () => {
    const { batch, acks, retries } = engineBatch([{ user_id: 'no-such-angler', trip_id: null }])
    const broken = { ...env, DB: { prepare: () => { throw new Error('D1 unavailable') } } as unknown as D1Database }

    await worker.queue(batch, broken)

    expect(retries).toEqual([0])
    expect(acks).toEqual([])
  })
})

describe('the pattern_cache adapter', () => {
  it('projects only the all-species family, because pattern_cache has no outcome column', async () => {
    const userId = await seedAngler({ email: 'v2-adapter@example.com', trips: hotTrips(12) })
    const result = runEngine(await loadEngineInput(env.DB, userId, NOW))

    // The engine really did produce a species family here — otherwise the filter proves nothing.
    expect(result.families.some((f) => f.outcome !== 'all')).toBe(true)

    const rows = v2ToPatternCache(result)
    expect(rows.length).toBeGreaterThan(0)

    // Without the outcome filter, a smallmouth finding and an all-species finding on the same
    // scope/dimension/bucket would land as two rows the feed cannot tell apart.
    const keys = rows.map((r) => `${r.scope}|${r.dimension}|${r.bucket}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('carries the shrunk multiplier and exposed-trip count onto the row', async () => {
    const userId = await seedAngler({ email: 'v2-adapter-fields@example.com', trips: hotTrips(12) })
    const result = runEngine(await loadEngineInput(env.DB, userId, NOW))
    const rows = v2ToPatternCache(result)

    const falling = rows.find((r) => r.dimension === 'pressure_trend' && r.bucket === 'falling')
    expect(falling).toBeDefined()
    expect(falling!.rate).toBeCloseTo(falling!.catches / falling!.hours)
    expect(falling!.baseline_rate).toBeGreaterThan(0)
    expect(falling!.multiplier).toBeGreaterThan(1)
    expect(['early', 'promising', 'solid']).toContain(falling!.confidence)
    // Exposed trips, not catching trips: a trip that got skunked on it is evidence about it.
    expect(falling!.trips).toBe(12)
  })
})
