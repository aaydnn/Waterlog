import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { runEngineForUser } from '../src/lib/v2/run'
import { seedAngler, type AnglerSeed } from './seed'

/**
 * The engine cutover (ADR-0017): `PATTERN_ENGINE_VERSION = "v2"` hands the feed to the v2 engine.
 *
 * The properties that matter are the ones that would hurt if they were wrong: two engines must
 * never both write `pattern_cache`, the sweep must keep working after the flip, and flipping back
 * must be enough to restore v1 — a cutover you cannot reverse is not a cutover, it is a migration.
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

function scheduledEvent(time = NOW): ScheduledController {
  return { cron: '0 8 * * *', scheduledTime: time, noRetry: () => {} } as ScheduledController
}

const v2Env = () => ({ ...env, PATTERN_ENGINE_VERSION: 'v2' })

describe('the nightly sweep under the cutover', () => {
  it('stops enqueueing v1 once v2 is primary', async () => {
    const userId = await seedAngler({ email: 'cutover-sweep@example.com', trips: hotTrips(12) })
    const v1Send = vi.spyOn(env.PATTERN_QUEUE, 'send').mockResolvedValue(undefined as unknown as QueueSendResponse)
    const v2Send = vi.spyOn(env.ENGINE_QUEUE, 'send').mockResolvedValue(undefined as unknown as QueueSendResponse)
    try {
      await worker.scheduled(scheduledEvent(), v2Env())

      // Both engines writing pattern_cache would overwrite each other nightly, and whichever
      // finished last would win by accident.
      expect(v1Send).not.toHaveBeenCalled()
      const jobs = v2Send.mock.calls.map(([job]) => job as { user_id: string })
      expect(jobs.some((job) => job.user_id === userId)).toBe(true)
    } finally {
      v1Send.mockRestore()
      v2Send.mockRestore()
    }
  })

  it('goes back to enqueueing both the moment the flag is anything else', async () => {
    const userId = await seedAngler({ email: 'cutover-revert@example.com', trips: hotTrips(12) })
    const v1Send = vi.spyOn(env.PATTERN_QUEUE, 'send').mockResolvedValue(undefined as unknown as QueueSendResponse)
    const v2Send = vi.spyOn(env.ENGINE_QUEUE, 'send').mockResolvedValue(undefined as unknown as QueueSendResponse)
    try {
      // A typo in a deploy var must fail safe: the angler keeps the feed that has been working.
      await worker.scheduled(scheduledEvent(), { ...env, PATTERN_ENGINE_VERSION: 'V2 ' })

      const v1Jobs = v1Send.mock.calls.map(([job]) => job as { user_id: string })
      expect(v1Jobs.some((job) => job.user_id === userId)).toBe(true)
      expect(v2Send).toHaveBeenCalled()
    } finally {
      v1Send.mockRestore()
      v2Send.mockRestore()
    }
  })
})

describe('the v2 engine as primary', () => {
  it('publishes the feed the app actually reads', async () => {
    const userId = await seedAngler({ email: 'cutover-feed@example.com', trips: hotTrips(12) })

    const shadow = await runEngineForUser(env.DB, userId, NOW)
    expect(shadow.feedRows).toBe(0)
    const beforeRows = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(beforeRows!.n).toBe(0)

    const primary = await runEngineForUser(env.DB, userId, NOW, { primary: true })
    expect(primary.feedRows).toBeGreaterThan(0)

    const rows = await env.DB.prepare(
      'SELECT scope, dimension, bucket, catches, hours, rate, baseline_rate, multiplier, confidence, trips FROM pattern_cache WHERE user_id = ?',
    )
      .bind(userId)
      .all<Record<string, number | string>>()

    expect(rows.results.length).toBe(primary.feedRows)
    const falling = rows.results.find((r) => r.dimension === 'pressure_trend' && r.bucket === 'falling')
    expect(falling).toBeDefined()
    // The shrunk multiplier, which is the one ADR-0017 says the engine actually believes.
    expect(falling!.multiplier as number).toBeGreaterThan(1)
    expect(falling!.multiplier as number).toBeLessThan(2.67)
    expect(['early', 'promising', 'solid']).toContain(falling!.confidence)

    // No two rows share a scope/dimension/bucket. v2 computes per-species families that
    // `pattern_cache` has no column for, and projecting them would put indistinguishable
    // duplicates in the feed.
    const keys = rows.results.map((r) => `${r.scope}|${r.dimension}|${r.bucket}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('claims completed_at, so the sweep does not think every angler is overdue forever', async () => {
    const userId = await seedAngler({ email: 'cutover-completed@example.com', trips: hotTrips(12) })

    await runEngineForUser(env.DB, userId, NOW)
    const shadowRun = await env.DB.prepare('SELECT completed_at FROM pattern_runs WHERE user_id = ?')
      .bind(userId)
      .first<{ completed_at: number | null }>()
    // In shadow it stays v1's to claim.
    expect(shadowRun!.completed_at).toBeNull()

    await runEngineForUser(env.DB, userId, NOW, { primary: true })
    const primaryRun = await env.DB.prepare('SELECT completed_at, result_json FROM pattern_runs WHERE user_id = ?')
      .bind(userId)
      .first<{ completed_at: number | null; result_json: string | null }>()
    expect(primaryRun!.completed_at).toBe(NOW)
    // And it still wrote its own columns in the same run.
    expect(primaryRun!.result_json).toBeTruthy()
  })

  it('empties a water that has stopped producing instead of leaving last month up', async () => {
    const userId = await seedAngler({ email: 'cutover-prune@example.com', trips: hotTrips(12) })
    await runEngineForUser(env.DB, userId, NOW, { primary: true })

    // A stale row on a water this run knows nothing about reads as current until something
    // removes it.
    await env.DB.prepare(
      `INSERT INTO pattern_cache (id, user_id, scope, dimension, bucket, catches, hours, rate,
                                  baseline_rate, multiplier, confidence, trips, computed_at)
       VALUES ('stale1', ?, 'w_gone', 'sky', 'overcast', 9, 9, 1, 0.5, 2, 'solid', 4, ?)`,
    )
      .bind(userId, NOW)
      .run()

    await runEngineForUser(env.DB, userId, NOW, { primary: true })

    const stale = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ? AND scope = 'w_gone'",
    )
      .bind(userId)
      .first<{ n: number }>()
    expect(stale!.n).toBe(0)
  })

  it('replaces the feed rather than appending to it on a second run', async () => {
    const userId = await seedAngler({ email: 'cutover-idempotent@example.com', trips: hotTrips(12) })
    const first = await runEngineForUser(env.DB, userId, NOW, { primary: true })
    const second = await runEngineForUser(env.DB, userId, NOW + 86_400_000, { primary: true })

    expect(second.feedRows).toBe(first.feedRows)
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(rows!.n).toBe(first.feedRows)
  })

  it('nominates the first pattern for a push only as primary', async () => {
    const userId = await seedAngler({ email: 'cutover-push@example.com', trips: hotTrips(12) })

    const shadow = await runEngineForUser(env.DB, userId, NOW)
    expect(shadow.firstPattern).toBe(false)

    const primary = await runEngineForUser(env.DB, userId, NOW, { primary: true })
    // The fixture reaches `emerging`, which brief §5 says is worth announcing. `hypothesis` is
    // not — it is the engine's shortlist, not a claim.
    expect(primary.firstPattern).toBe(true)
  })

  it('says nothing and publishes nothing for an angler with too little exposure', async () => {
    const userId = await seedAngler({
      email: 'cutover-thin@example.com',
      trips: [{ hours: 2, conditions: { pressure_trend: 'falling' }, catches: [{ hour: 0 }] }],
    })
    const outcome = await runEngineForUser(env.DB, userId, NOW, { primary: true })

    expect(outcome.empty).toBe(true)
    expect(outcome.feedRows).toBe(0)
    expect(outcome.firstPattern).toBe(false)
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(rows!.n).toBe(0)
  })
})

describe('the v2 consumer under the cutover', () => {
  it('publishes the feed when a queue message arrives and v2 is primary', async () => {
    const userId = await seedAngler({ email: 'cutover-consumer@example.com', trips: hotTrips(12) })
    const acks: number[] = []
    const batch = {
      queue: 'pattern-engine',
      messages: [
        {
          id: 'c0',
          timestamp: new Date(NOW),
          body: { user_id: userId, trip_id: null },
          attempts: 1,
          ack: () => acks.push(0),
          retry: () => {},
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>

    await worker.queue(batch, v2Env())

    expect(acks).toEqual([0])
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(rows!.n).toBeGreaterThan(0)
  })
})
