/** Which accounts have ever signed in on this device.
 *
 * Some local rows predate the queue recording an owner (pre-v3), and there is no way to ask
 * them whose they are. Handing them to whoever flushes first is right on a phone one angler
 * has ever used and a data leak on one that two have — and this is the only fact that tells
 * the two apart. So an unowned row is adopted by elimination: if exactly one account has ever
 * been here, it can only be theirs.
 *
 * Only ids are kept, and only to answer that one question. Storage is best-effort: a device
 * that can't remember is treated as never having seen a second account, which matches the
 * common case (and X-Waterlog-User still stops any write reaching an account whose session
 * this tab doesn't actually hold). */
const KEY = 'waterlog.device_accounts'

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function seenAccounts(): string[] {
  try {
    const raw = store()?.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function rememberAccount(userId: string): void {
  const seen = seenAccounts()
  if (seen.includes(userId)) return
  try {
    store()?.setItem(KEY, JSON.stringify([...seen, userId]))
  } catch {
    // see the note above — unrecordable is treated as single-account
  }
}

/** Whether a row with no recorded owner may be treated as this user's. */
export function canAdoptUnowned(userId: string | null): boolean {
  const seen = seenAccounts()
  if (seen.length === 0) return true
  return seen.length === 1 && (userId === null || seen[0] === userId)
}

/** Test seam. */
export function forgetDeviceAccounts(): void {
  try {
    store()?.removeItem(KEY)
  } catch {
    // nothing recorded, nothing to forget
  }
}
