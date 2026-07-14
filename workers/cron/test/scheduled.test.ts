import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

describe('cron stub', () => {
  it('logs the scheduled invocation without throwing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const event = {
      cron: '0 8 * * *',
      scheduledTime: Date.UTC(2026, 0, 1, 8, 0, 0),
      noRetry: () => {},
    } as ScheduledController

    await worker.scheduled(event, { DB: {} as D1Database }, {
      waitUntil: () => {},
      passThroughException: () => {},
    } as unknown as ExecutionContext)

    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
