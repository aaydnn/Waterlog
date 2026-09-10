/** Tells the other tabs on this device that the session changed.
 *
 * A PWA left open in two tabs is normal — one on the journal, one on the water. Signing out in
 * one and back in as somebody else in the other used to leave the first tab convinced it was
 * still the old angler, and its next flush would push that angler's queue under the new
 * cookie. The server refuses that write (X-Waterlog-User / 409), but a tab showing the wrong
 * person's journal is its own problem, so the change is announced instead of discovered.
 *
 * BroadcastChannel is absent in some browsers and in some test environments; there is no
 * fallback because nothing here is load-bearing for correctness — the 409 contract is. */
export interface SessionMessage {
  /** The user now signed in on this device, or null for signed out. */
  user_id: string | null
}

const CHANNEL_NAME = 'waterlog-session'

let channel: BroadcastChannel | null | undefined

/** One channel per tab: a BroadcastChannel never delivers a tab its own posts, which is what
 * keeps two tabs from echoing a change back and forth. */
function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null
  } catch {
    channel = null
  }
  return channel
}

export function publishSessionChange(userId: string | null): void {
  try {
    getChannel()?.postMessage({ user_id: userId } satisfies SessionMessage)
  } catch {
    // A closed or unsupported channel is not a reason to fail a sign-out.
  }
}

/** Returns the unsubscribe function. */
export function subscribeToSessionChanges(onChange: (userId: string | null) => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const listener = (event: MessageEvent): void => {
    const data = event.data as Partial<SessionMessage> | null
    if (!data || typeof data !== 'object' || !('user_id' in data)) return
    onChange(data.user_id ?? null)
  }
  ch.addEventListener('message', listener)
  return () => ch.removeEventListener('message', listener)
}

/** Test seam: drops the cached channel so each test file starts clean. */
export function closeSessionChannel(): void {
  try {
    channel?.close()
  } catch {
    // already closed
  }
  channel = undefined
}
