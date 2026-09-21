// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api-client'
import { WebPushRegistrar, decodeApplicationServerKey } from './push-registrar'

const KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'

function stubSubscription(overrides: Partial<PushSubscription> = {}) {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    getKey: (name: string) =>
      new Uint8Array(name === 'auth' ? [1, 2, 3, 4] : [9, 8, 7, 6, 5]).buffer,
    ...overrides,
  } as unknown as PushSubscription
}

function stubPlatform({
  permission = 'granted',
  existing = null as PushSubscription | null,
  subscribe = vi.fn(async () => stubSubscription()),
} = {}) {
  const ready = Promise.resolve({
    pushManager: { getSubscription: vi.fn(async () => existing), subscribe },
  } as unknown as ServiceWorkerRegistration)
  vi.stubGlobal('navigator', { serviceWorker: { ready } })
  vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => permission) })
  Object.defineProperty(window, 'PushManager', { value: function () {}, configurable: true })
  return { subscribe }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('decodeApplicationServerKey', () => {
  it('decodes a base64url VAPID key to the 65 bytes PushManager wants', () => {
    expect(decodeApplicationServerKey(KEY)).toHaveLength(65)
  })
})

describe('WebPushRegistrar', () => {
  it('subscribes and registers the browser with the server', async () => {
    vi.spyOn(apiClient, 'pushKey').mockResolvedValue({ key: KEY })
    const subscribeToPush = vi.spyOn(apiClient, 'subscribeToPush').mockResolvedValue({ ok: true })
    stubPlatform()

    const token = await new WebPushRegistrar().register()

    expect(token).toEqual({ platform: 'web', token: 'https://fcm.googleapis.com/fcm/send/abc' })
    expect(subscribeToPush).toHaveBeenCalledWith({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: 'CQgHBgU',
      auth: 'AQIDBA',
    })
  })

  it('reuses a subscription the browser already has rather than minting a second endpoint', async () => {
    vi.spyOn(apiClient, 'pushKey').mockResolvedValue({ key: KEY })
    vi.spyOn(apiClient, 'subscribeToPush').mockResolvedValue({ ok: true })
    const { subscribe } = stubPlatform({ existing: stubSubscription() })

    await new WebPushRegistrar().register()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('returns null, and registers nothing, when the angler declines', async () => {
    vi.spyOn(apiClient, 'pushKey').mockResolvedValue({ key: KEY })
    const subscribeToPush = vi.spyOn(apiClient, 'subscribeToPush')
    stubPlatform({ permission: 'denied' })

    expect(await new WebPushRegistrar().register()).toBeNull()
    expect(subscribeToPush).not.toHaveBeenCalled()
  })

  it('never prompts when the server has no push keys configured', async () => {
    vi.spyOn(apiClient, 'pushKey').mockRejectedValue(new Error('503'))
    const { subscribe } = stubPlatform()
    const requestPermission = vi.spyOn(Notification, 'requestPermission')

    expect(await new WebPushRegistrar().register()).toBeNull()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('returns null on a browser that cannot do push at all', async () => {
    vi.stubGlobal('navigator', {})
    expect(await new WebPushRegistrar().register()).toBeNull()
  })
})
