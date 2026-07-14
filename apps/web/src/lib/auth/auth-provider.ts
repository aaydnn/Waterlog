import { NotImplementedError } from '../errors'

// Platform seam (ADR-0001): web auth (magic link + Google) and native auth
// (adds Sign in with Apple in Epic 5.5) share this interface. Feature code
// imports the interface, never a concrete implementation.

/** 'apple' is accepted by the type now so the interface doesn't change when
 * Sign in with Apple lands in Epic 5.5 — no web implementation until then. */
export type AuthMethod = 'magic-link' | 'google' | 'apple'

export interface Session {
  userId: string
  email: string
}

export interface AuthProvider {
  signIn(method: AuthMethod): Promise<Session>
  signOut(): Promise<void>
}

/** Web stub — wired to the workers/api auth routes as part of Epic 1's shell. */
export class WebAuthProvider implements AuthProvider {
  signIn(_method: AuthMethod): Promise<Session> {
    return Promise.reject(new NotImplementedError('AuthProvider.signIn'))
  }

  signOut(): Promise<void> {
    return Promise.reject(new NotImplementedError('AuthProvider.signOut'))
  }
}
