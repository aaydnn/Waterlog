import type { SyncEngine } from './sync-engine'

/** Injectable seams so tests don't need real window/document/navigator globals. */
export interface AutoFlushOptions {
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  document?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
  navigator?: Pick<Navigator, 'onLine'>
}

/** Drains the offline queue without waiting for the angler to do something.
 *
 * Capture and trip start/end each flush on their own, but out of cell range is the *normal*
 * case for this product: a catch logged on the water would otherwise sit in IndexedDB until the
 * angler happened to take another action, which is how "syncs later" (packet principle 5)
 * quietly becomes "never". So we also flush when the app mounts, when the browser reports it is
 * back online, and when the tab becomes visible again — the moment a backgrounded PWA gets to
 * run code after the truck reaches pavement.
 *
 * No session re-check runs before these flushes on purpose. The tab's idea of who is signed in
 * can be stale, but every write names its account (X-Waterlog-User) and the server refuses the
 * batch if that isn't the cookie's user, so a stale tab can't misfile anything — and an
 * /api/me on every foreground would be one more request to fail out of range for no safety we
 * don't already have.
 *
 * Returns the unsubscribe function.
 */
export function startAutoFlush(engine: SyncEngine, options: AutoFlushOptions = {}): () => void {
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window)
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const nav = options.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator)

  let stopped = false
  let inFlight = false
  let requestedAgain = false

  function request(): void {
    if (stopped) return
    // Known-offline: skip the doomed request. `online` will fire when that changes.
    if (nav?.onLine === false) return
    if (inFlight) {
      // A trigger arrived mid-flush; whatever it was reacting to may not be in this batch.
      requestedAgain = true
      return
    }
    inFlight = true
    void engine
      .flush()
      .catch(() => {
        // flush() already swallows offline failures and leaves rows queued; anything reaching
        // here is a bug in a lower layer, and retrying on the next trigger is still right.
      })
      .then(() => {
        inFlight = false
        if (requestedAgain) {
          requestedAgain = false
          request()
        }
      })
  }

  const onOnline = (): void => request()
  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === 'visible') request()
  }

  win?.addEventListener('online', onOnline)
  doc?.addEventListener('visibilitychange', onVisibilityChange)
  request()

  return () => {
    stopped = true
    win?.removeEventListener('online', onOnline)
    doc?.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
