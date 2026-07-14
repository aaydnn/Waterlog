import { describe, expect, it } from 'vitest'
import { NotImplementedError } from './errors'
import { WebSyncEngine } from './sync/sync-engine'
import { WebPushRegistrar } from './push/push-registrar'
import { WebAuthProvider } from './auth/auth-provider'

describe('platform seams (ADR-0001)', () => {
  it('sync engine web stub throws NotImplementedError', async () => {
    const sync = new WebSyncEngine()
    await expect(sync.enqueue({})).rejects.toBeInstanceOf(NotImplementedError)
    await expect(sync.flush()).rejects.toBeInstanceOf(NotImplementedError)
  })

  it('push registrar web stub throws NotImplementedError', async () => {
    await expect(new WebPushRegistrar().register()).rejects.toBeInstanceOf(NotImplementedError)
  })

  it('auth provider web stub throws NotImplementedError', async () => {
    const auth = new WebAuthProvider()
    await expect(auth.signIn('magic-link')).rejects.toBeInstanceOf(NotImplementedError)
    await expect(auth.signOut()).rejects.toBeInstanceOf(NotImplementedError)
  })
})
