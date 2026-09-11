/** A sign-out this device has decided on but the server hasn't confirmed.
 *
 * Tapping "Sign out" out of range used to look exactly like a real sign-out while the HttpOnly
 * cookie stayed valid — reload once back on wifi and you were signed in again, on a phone you
 * may have handed to somebody else. The flag survives that reload: the app retries the
 * revocation before it will trust any cookie it finds.
 *
 * localStorage, not Dexie: this has to be readable synchronously on the first paint, and it is
 * one boolean. Every access is guarded — Safari private mode throws on access, and a browser
 * with storage blocked should still be able to sign out (it just can't remember that it tried).
 */
const KEY = 'waterlog.pending_logout'

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function markLogoutPending(): void {
  try {
    store()?.setItem(KEY, '1')
  } catch {
    // Nothing to do: the UI still locks, we just can't remember to retry.
  }
}

export function isLogoutPending(): boolean {
  try {
    return store()?.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function clearLogoutPending(): void {
  try {
    store()?.removeItem(KEY)
  } catch {
    // see markLogoutPending
  }
}
