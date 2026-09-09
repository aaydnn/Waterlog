import type { User } from '@waterlog/schema'
import { ApiError, apiClient } from '../api-client'

// Platform seam (ADR-0001): web auth (magic link + Google) and native auth
// (adds Sign in with Apple in Epic 5.5) share this interface. Feature code
// imports the interface, never a concrete implementation.

/** 'apple' is accepted by the type now so the interface doesn't change when
 * Sign in with Apple lands in Epic 5.5 — no web implementation until then. */
export type AuthMethod = 'magic-link' | 'google' | 'apple'

export interface SignInOptions {
  /** Required for 'magic-link'; ignored by the redirect flows. */
  email?: string
}

/** Neither web flow can hand back a session then and there — Google leaves the page and the
 * magic link arrives by email — so the result says what happened instead of pretending to be a
 * session. Native Google *does* return one directly, which is why 'session' is in the union. */
export type SignInResult =
  | { kind: 'redirecting' }
  | { kind: 'email-sent'; email: string }
  | { kind: 'session'; user: User }

export interface AuthProvider {
  signIn(method: AuthMethod, options?: SignInOptions): Promise<SignInResult>
  signOut(): Promise<void>
  /** The signed-in user, or null when there is no valid session. */
  currentUser(): Promise<User | null>
}

export class UnsupportedAuthMethodError extends Error {
  constructor(method: AuthMethod) {
    super(`auth method not available on web: ${method}`)
    this.name = 'UnsupportedAuthMethodError'
  }
}

/** Web implementation, wired to the workers/api auth routes. Both flows end at
 * `/api/auth/*` on the app's own origin — same-origin is what lets the session cookie stick
 * (see the Pages /api/* proxy), so these are relative paths, never the Worker's own host. */
export class WebAuthProvider implements AuthProvider {
  constructor(private readonly redirect: (url: string) => void = (url) => window.location.assign(url)) {}

  async signIn(method: AuthMethod, options: SignInOptions = {}): Promise<SignInResult> {
    if (method === 'google') {
      this.redirect('/api/auth/google')
      return { kind: 'redirecting' }
    }
    if (method === 'magic-link') {
      const email = options.email?.trim()
      if (!email) throw new Error('signIn("magic-link") requires an email')
      await apiClient.requestMagicLink(email)
      return { kind: 'email-sent', email }
    }
    throw new UnsupportedAuthMethodError(method)
  }

  async signOut(): Promise<void> {
    await apiClient.logout()
  }

  async currentUser(): Promise<User | null> {
    try {
      return (await apiClient.me()).user
    } catch (error) {
      // 401 is the answer "nobody is signed in", not a failure. Anything else — offline, a
      // 500 — is unknown, and claiming "signed out" would throw away a working session.
      if (error instanceof ApiError && error.status === 401) return null
      throw error
    }
  }
}
