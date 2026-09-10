import { sha256Hex } from './crypto'

/** A fixed-window quota: at most `limit` hits per `windowMs`. */
export interface RateLimitRule {
  limit: number
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until the current window closes — the Retry-After value. */
  retryAfterSeconds: number
}

const WINDOW_MS = 15 * 60 * 1000 // 15 minutes

/**
 * POST /api/auth/magic-link quotas.
 *
 * Per address: 5 per 15 minutes. A human who mistypes, retries, and asks for a fresh link twice
 * more stays under it; a mailbox-flooding campaign against one victim does not.
 *
 * Per IP: 20 per 15 minutes — four distinct addresses at the per-address cap. Households and
 * offices behind one NAT share an IP, so this is deliberately looser than the address cap; it is
 * there to blunt an enumeration sweep across many addresses from one source, not to police a
 * single user.
 */
export const MAGIC_LINK_PER_EMAIL: RateLimitRule = { limit: 5, windowMs: WINDOW_MS }
export const MAGIC_LINK_PER_IP: RateLimitRule = { limit: 20, windowMs: WINDOW_MS }

/** Requests with no CF-Connecting-IP (tests, direct workerd invocation) share this bucket
 * rather than bypassing the limit — an unattributable request is still a request. */
export const UNKNOWN_IP = 'unknown'

export function magicLinkIpBucket(ip: string): string {
  return `magic-link:ip:${ip}`
}

/** The address is hashed: the bucket key is an index, not a place to store a user's email. */
export async function magicLinkEmailBucket(email: string): Promise<string> {
  return `magic-link:email:${await sha256Hex(email)}`
}

/**
 * Counts one hit against `bucket` and says whether it is within the rule.
 *
 * One statement: the UPSERT either opens a new window (the stored one has run out) or increments
 * the live one, and RETURNING hands back the post-increment count — so two concurrent requests
 * cannot both read the same pre-increment value.
 *
 * A rejected request still increments. That is intentional: sustained abuse keeps the window
 * pinned shut rather than letting a caller free-wheel at exactly the limit.
 */
export async function consumeRateLimit(
  db: D1Database,
  bucket: string,
  rule: RateLimitRule,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  // Opportunistic sweep of dead windows — one indexed DELETE, so the table cannot grow
  // without bound between deploys.
  await db.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now).run()

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, count, window_start, expires_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN excluded.window_start >= rate_limits.expires_at
                      THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN excluded.window_start >= rate_limits.expires_at
                             THEN excluded.window_start ELSE rate_limits.window_start END,
         expires_at = CASE WHEN excluded.window_start >= rate_limits.expires_at
                           THEN excluded.expires_at ELSE rate_limits.expires_at END
       RETURNING count, expires_at`,
    )
    .bind(bucket, now, now + rule.windowMs)
    .first<{ count: number; expires_at: number }>()

  // No row back would mean the UPSERT did not apply; fail closed rather than wave it through.
  if (!row) return { allowed: false, retryAfterSeconds: Math.ceil(rule.windowMs / 1000) }

  return {
    allowed: row.count <= rule.limit,
    retryAfterSeconds: Math.max(1, Math.ceil((row.expires_at - now) / 1000)),
  }
}
