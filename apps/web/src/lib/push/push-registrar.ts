import { apiClient } from '../api-client'
import { NotImplementedError } from '../errors'

// Platform seam (ADR-0001): web push and APNs (via Capacitor) both sit
// behind this interface. Feature code imports the interface only.

export interface PushToken {
  platform: 'web' | 'ios'
  token: string
}

export interface PushRegistrar {
  /** Returns null when the user declines or the platform can't do push. */
  register(): Promise<PushToken | null>
}

/** The application server key arrives as base64url and `PushManager.subscribe` wants bytes. */
export function decodeApplicationServerKey(base64Url: string): Uint8Array {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeKey(buffer: ArrayBuffer | null): string {
  const bytes = new Uint8Array(buffer ?? new ArrayBuffer(0))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Real Web Push registration (packet §05).
 *
 * Every step can legitimately fail — an unsupported browser, a declined prompt, a server with no
 * VAPID keys configured — and every one of them returns null rather than throwing. A notification
 * the angler never asked for is a feature; a crash while asking is not.
 *
 * The caller decides *when* to ask. Prompting on load is the fastest way to get permanently
 * denied, so this is invoked from a moment the angler is already engaged with.
 */
export class WebPushRegistrar implements PushRegistrar {
  async register(): Promise<PushToken | null> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
    if (typeof window === 'undefined' || !('PushManager' in window)) return null

    let applicationServerKey: string
    try {
      applicationServerKey = (await apiClient.pushKey()).key
    } catch {
      // Push is not configured on this deployment. Say nothing and prompt for nothing.
      return null
    }

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return null

    const registration = await navigator.serviceWorker.ready
    // An existing subscription is reused: re-subscribing would mint a new endpoint and orphan the
    // old one on the push service.
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // The underlying buffer, because the DOM types want a plain ArrayBuffer here.
        applicationServerKey: decodeApplicationServerKey(applicationServerKey).buffer as ArrayBuffer,
      }))

    const p256dh = encodeKey(subscription.getKey('p256dh'))
    const auth = encodeKey(subscription.getKey('auth'))
    if (!p256dh || !auth) return null

    await apiClient.subscribeToPush({ endpoint: subscription.endpoint, p256dh, auth })
    return { platform: 'web', token: subscription.endpoint }
  }
}

/** iOS via Capacitor, when the wrapper lands (packet §05). */
export class NativePushRegistrar implements PushRegistrar {
  register(): Promise<PushToken | null> {
    return Promise.reject(new NotImplementedError('NativePushRegistrar.register'))
  }
}
