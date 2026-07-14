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

/** Web stub — real Web Push registration arrives with the briefing epic. */
export class WebPushRegistrar implements PushRegistrar {
  register(): Promise<PushToken | null> {
    return Promise.reject(new NotImplementedError('PushRegistrar.register'))
  }
}
