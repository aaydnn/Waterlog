import { rememberAccount } from './device-accounts'

/** Who the offline queue is writing for.
 *
 * The app is gated on sign-in, so every capture happens under a known user — but the queue
 * outlives the session: a catch logged in a cove can still be sitting in IndexedDB when the
 * cookie expires, and whoever signs in next on that device would otherwise inherit it. Rows are
 * stamped with this at enqueue time and only flushed for the matching user.
 *
 * Deliberately not persisted. It is set from `/api/me` at boot; a stale copy in localStorage
 * would be a worse answer than asking the server. */
let activeUserId: string | null = null

export function setActiveUserId(userId: string | null): void {
  activeUserId = userId
  // The *set* of accounts that have used this device does persist — not as a session, but as
  // the one thing that says whether an unowned local row can only belong to one person.
  if (userId !== null) rememberAccount(userId)
}

export function getActiveUserId(): string | null {
  return activeUserId
}
