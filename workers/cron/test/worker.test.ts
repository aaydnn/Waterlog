import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { seedAngler, type AnglerSeed } from './seed'

const NOW = Date.UTC(2026, 8, 15, 8)

function hotTrips(): AnglerSeed['trips'] {
  return Array.from({ length: 6 }, () => ({
    hours: 4,
    conditions: { pressure_trend: 'stable' as const },
    hourOverrides: { 0: { pressure_trend: 'falling' as const } },
    catches: [{ hour: 0, color: 'chartreuse' }, { hour: 0, color: 'chartreuse' }, { hour: 1, color: 'white' }],
  }))
}

function scheduledEvent(time = NOW): ScheduledController {
  return { cron: '0 8 * * *', scheduledTime: time, noRetry: () => {} } as ScheduledController
}

function messageBatch(bodies: unknown[]) {
  const acks: number[] = []
  const retries: number[] = []
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(NOW),
    body,
    attempts: 1,
    ack: () => acks.push(i),
    retry: () => retries.push(i),
  }))
  return {
    batch: { queue: 'waterlog-patterns', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<unknown>,
    acks,
    retries,
  }
}

describe('the nightly trigger', () => {
  it('enqueues one job per angler who is due and does no arithmetic itself', async () => {
    const userId = await seedAngler({ email: 'sched@example.com', trips: hotTrips() })
    // Stubbed rather than called through: this worker consumes the queue it produces onto, so a
    // real send would run the consumer outside the test's own storage frame.
    const send = vi.spyOn(env.PATTERN_QUEUE, 'send').mockResolvedValue(undefined as unknown as QueueSendResponse)
    // Both queues are stubbed for the same reason: this worker consumes what it produces, so a
    // real send would run a consumer outside the test's own storage frame.
    const engineSend = vi
      .spyOn(env.ENGINE_QUEUE, 'send')
      .mockResolvedValue(undefined as unknown as QueueSendResponse)
    try {
      await worker.scheduled(scheduledEvent(), env)
      const jobs = send.mock.calls.map(([job]) => job as { user_id: string; cursor: string | null })
      expect(jobs.some((job) => job.user_id === userId && job.cursor === null)).toBe(true)
      // The same angler goes to v2 as well, so both engines see the same night.
      const engineJobs = engineSend.mock.calls.map(([job]) => job as { user_id: string })
      expect(engineJobs.some((job) => job.user_id === userId)).toBe(true)
      // Nothing was computed by the trigger itself.
      const cached = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
        .bind(userId)
        .first<{ n: number }>()
      expect(cached!.n).toBe(0)
    } finally {
      send.mockRestore()
      engineSend.mockRestore()
    }
  })

  it('still enqueues v1 when the v2 queue rejects the send', async () => {
    const userId = await seedAngler({ email: 'sched-v2-down@example.com', trips: hotTrips() })
    const send = vi.spyOn(env.PATTERN_QUEUE, 'send').mockResolvedValue(undefined as unknown as QueueSendResponse)
    const engineSend = vi
      .spyOn(env.ENGINE_QUEUE, 'send')
      .mockRejectedValue(new Error('queue unavailable'))
    try {
      await worker.scheduled(scheduledEvent(), env)
      // The shadow engine being unreachable must not cost the angler their real feed.
      const jobs = send.mock.calls.map(([job]) => job as { user_id: string })
      expect(jobs.some((job) => job.user_id === userId)).toBe(true)
    } finally {
      send.mockRestore()
      engineSend.mockRestore()
    }
  })
})

describe('the queue consumer', () => {
  it('computes an angler and acknowledges the message', async () => {
    const userId = await seedAngler({ email: 'consume@example.com', trips: hotTrips() })
    const { batch, acks } = messageBatch([{ user_id: userId, cursor: null }])
    await worker.queue(batch, env)

    expect(acks).toEqual([0])
    const cached = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(cached!.n).toBeGreaterThan(0)
  })

  it('writes no duplicates when the same message is delivered twice', async () => {
    const userId = await seedAngler({ email: 'redelivered@example.com', trips: hotTrips() })
    await worker.queue(messageBatch([{ user_id: userId, cursor: null }]).batch, env)
    const first = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()

    await worker.queue(messageBatch([{ user_id: userId, cursor: null }]).batch, env)
    const second = await env.DB.prepare('SELECT COUNT(*) AS n FROM pattern_cache WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()

    expect(second!.n).toBe(first!.n)
  })

  it('drops a malformed message instead of retrying it forever', async () => {
    const { batch, acks, retries } = messageBatch([{ nonsense: true }])
    await worker.queue(batch, env)
    expect(acks).toEqual([0])
    expect(retries).toEqual([])
  })

  it('retries a message whose recompute threw', async () => {
    const { batch, acks, retries } = messageBatch([{ user_id: 'no-such-angler', cursor: null }])
    const broken = { ...env, DB: { prepare: () => { throw new Error('D1 unavailable') } } } as unknown as typeof env
    await worker.queue(batch, broken)
    expect(retries).toEqual([0])
    expect(acks).toEqual([])
  })
})
