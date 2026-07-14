import { describe, expect, it } from 'vitest'
import type { Catch } from '@waterlog/schema'
import { NotImplementedError } from './errors'
import { WebSyncEngine } from './sync/sync-engine'
import { WebPushRegistrar } from './push/push-registrar'
import { WebAuthProvider } from './auth/auth-provider'

describe('platform seams (ADR-0001)', () => {
  it('sync engine web stub throws NotImplementedError', async () => {
    const sync = new WebSyncEngine()
    const record: Catch = {
      id: 'cat_test01',
      user_id: 'usr_test01',
      trip_id: 'trp_test01',
      lure_id: null,
      species: 'largemouth_bass',
      caught_at: 1780746900000,
      lat: null,
      lng: null,
      photo_key: null,
      length_mm: null,
      weight_g: null,
      depth_m: null,
      released: 1,
      notes: null,
      client_id: '01JX0000000000000000TEST',
      enrich_status: 'pending',
      created_at: 1780746900000,
      updated_at: 1780746900000,
      deleted_at: null,
    }
    await expect(sync.enqueue(record)).rejects.toBeInstanceOf(NotImplementedError)
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
