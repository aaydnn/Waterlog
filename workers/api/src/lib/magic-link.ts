import { generateToken, sha256Hex } from './crypto'

export const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes

/** Trimmed, lower-cased, and length-bounded — the form the DB and the rate-limit buckets
 * both key on, so `A@X.com ` and `a@x.com` cannot buy two separate quotas. */
export const MAX_EMAIL_LENGTH = 254 // RFC 5321 forward-path limit

export function normalizeEmail(rawEmail: string): string {
  return rawEmail.trim().toLowerCase()
}

/** One indexed DELETE. Cheap enough to run on every mint and every verify, which is what keeps
 * the table from accumulating dead rows forever — nothing else prunes it. */
async function sweepExpired(db: D1Database, now: number): Promise<void> {
  await db.prepare('DELETE FROM login_tokens WHERE expires_at <= ?').bind(now).run()
}

/**
 * Mints a single-use login token; only its sha256 hits the DB.
 *
 * Minting also invalidates that address's older unconsumed tokens, so at most one live link
 * exists per address at a time. Requesting a fresh link is the natural thing to do when the
 * first has not arrived, and it should not leave a widening set of working credentials behind —
 * bounded alongside the rate limit, it caps the blast radius of a leaked inbox to one link.
 */
export async function createLoginToken(db: D1Database, rawEmail: string): Promise<string> {
  const token = generateToken()
  const now = Date.now()
  const email = normalizeEmail(rawEmail)

  await sweepExpired(db, now)
  await db
    .prepare('UPDATE login_tokens SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL')
    .bind(now, email)
    .run()
  await db
    .prepare(
      'INSERT INTO login_tokens (id, email, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)',
    )
    .bind(await sha256Hex(token), email, now + LOGIN_TOKEN_TTL_MS, now)
    .run()
  return token
}

/** Returns the email for a live token and burns it; null when the token is
 * unknown, expired, superseded, or already consumed (replays fail here). */
export async function consumeLoginToken(db: D1Database, token: string): Promise<string | null> {
  const id = await sha256Hex(token)
  const now = Date.now()
  await sweepExpired(db, now)
  // Single guarded UPDATE so two concurrent verifies can't both win.
  const result = await db
    .prepare(
      'UPDATE login_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING email',
    )
    .bind(now, id, now)
    .first<{ email: string }>()
  return result?.email ?? null
}
