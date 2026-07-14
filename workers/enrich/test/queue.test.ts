import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

function fakeMessage(id: string) {
  return {
    id,
    timestamp: new Date(),
    body: {},
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

describe('enrich queue stub', () => {
  it('acks every message in the batch', async () => {
    const messages = [fakeMessage('m1'), fakeMessage('m2')]
    const batch = {
      queue: 'waterlog-enrich',
      messages,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<unknown>

    await worker.queue(batch, { DB: {} as D1Database })

    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce()
      expect(message.retry).not.toHaveBeenCalled()
    }
  })
})
