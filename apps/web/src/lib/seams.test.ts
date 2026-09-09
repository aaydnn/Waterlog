import { describe, expect, it } from 'vitest'
import { NotImplementedError } from './errors'
import { WebPushRegistrar } from './push/push-registrar'

// The sync engine seam has a real web implementation as of Epic 1 — see ./sync/sync-engine.test.ts —
// and auth as of Epic 3 (./auth/auth-provider.test.ts). Push remains an Epic 0 stub.
describe('platform seams (ADR-0001)', () => {
  it('push registrar web stub throws NotImplementedError', async () => {
    await expect(new WebPushRegistrar().register()).rejects.toBeInstanceOf(NotImplementedError)
  })
})
