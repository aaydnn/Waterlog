import { describe, expect, it } from 'vitest'
import { NotImplementedError } from './errors'
import { NativePushRegistrar } from './push/push-registrar'

// The sync engine seam has a real web implementation as of Epic 1 — see ./sync/sync-engine.test.ts —
// auth as of Epic 3 (./auth/auth-provider.test.ts), and web push as of Epic 4
// (./push/push-registrar.test.ts). The native side waits for the Capacitor wrap.
describe('platform seams (ADR-0001)', () => {
  it('native push registrar is still a stub', async () => {
    await expect(new NativePushRegistrar().register()).rejects.toBeInstanceOf(NotImplementedError)
  })
})
