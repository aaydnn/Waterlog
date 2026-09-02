import { describe, expect, it } from 'vitest'
import { NotImplementedError } from './errors'
import { WebPushRegistrar } from './push/push-registrar'
import { WebAuthProvider } from './auth/auth-provider'

// The sync engine seam has a real web implementation as of Epic 1 — see
// ./sync/sync-engine.test.ts. Push and auth remain Epic 0 stubs.
describe('platform seams (ADR-0001)', () => {
  it('push registrar web stub throws NotImplementedError', async () => {
    await expect(new WebPushRegistrar().register()).rejects.toBeInstanceOf(NotImplementedError)
  })

  it('auth provider web stub throws NotImplementedError', async () => {
    const auth = new WebAuthProvider()
    await expect(auth.signIn('magic-link')).rejects.toBeInstanceOf(NotImplementedError)
    await expect(auth.signOut()).rejects.toBeInstanceOf(NotImplementedError)
  })
})
