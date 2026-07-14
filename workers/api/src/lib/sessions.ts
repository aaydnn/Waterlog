import { generateToken, sha256Hex } from './crypto'

// Server-side sessions per the Lucia guide: the cookie carries the raw
// token, the DB stores its sha256, expiry slides on activity.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const RENEW_WINDOW_MS = SESSION_TTL_MS / 2 // extend once under 15 days remain

export interface SessionRow {
  id: string
  user_id: string
  expires_at: number
  created_at: number
}

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = generateToken()
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, expiresAt, now)
    .run()
  return { token, expiresAt }
}

/** Resolves a raw cookie token to its session, deleting it when expired and
 * sliding the expiry when it has under half its TTL left. */
export async function validateSession(db: D1Database, token: string): Promise<SessionRow | null> {
  const id = await sha256Hex(token)
  const session = await db
    .prepare('SELECT id, user_id, expires_at, created_at FROM sessions WHERE id = ?')
    .bind(id)
    .first<SessionRow>()
  if (!session) return null

  const now = Date.now()
  if (now >= session.expires_at) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run()
    return null
  }
  if (session.expires_at - now < RENEW_WINDOW_MS) {
    session.expires_at = now + SESSION_TTL_MS
    await db
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(session.expires_at, id)
      .run()
  }
  return session
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  await db
    .prepare('DELETE FROM sessions WHERE id = ?')
    .bind(await sha256Hex(token))
    .run()
}
