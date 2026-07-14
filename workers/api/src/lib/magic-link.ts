import { generateToken, sha256Hex } from './crypto'

export const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes

/** Mints a single-use login token; only its sha256 hits the DB. */
export async function createLoginToken(db: D1Database, rawEmail: string): Promise<string> {
  const token = generateToken()
  const now = Date.now()
  await db
    .prepare(
      'INSERT INTO login_tokens (id, email, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)',
    )
    .bind(await sha256Hex(token), rawEmail.trim().toLowerCase(), now + LOGIN_TOKEN_TTL_MS, now)
    .run()
  return token
}

/** Returns the email for a live token and burns it; null when the token is
 * unknown, expired, or already consumed (replays fail here). */
export async function consumeLoginToken(db: D1Database, token: string): Promise<string | null> {
  const id = await sha256Hex(token)
  const now = Date.now()
  // Single guarded UPDATE so two concurrent verifies can't both win.
  const result = await db
    .prepare(
      'UPDATE login_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING email',
    )
    .bind(now, id, now)
    .first<{ email: string }>()
  return result?.email ?? null
}
