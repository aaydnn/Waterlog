import type { CronBindings } from '../env'
import { sendPush, type PushTarget, type VapidKeys } from './web-push'

/**
 * The first-pattern push (packet §09 flow 3) — the retention moment the whole engine exists to
 * reach. It fires once per angler, ever.
 *
 * "Once" is enforced in the database, not in this function: `users.first_pattern_notified_at` is
 * stamped before anything is sent, with a conditional UPDATE that only one caller can win. A queue
 * that delivers the same message twice, or two scopes finishing in the same minute, cannot produce
 * two announcements.
 */

export function vapidKeysFrom(env: CronBindings): VapidKeys | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return null
  return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT }
}

/** Wins exactly once per angler. The `IS NULL` guard is the whole mechanism. */
async function claimFirstPattern(db: D1Database, userId: string, now: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE users SET first_pattern_notified_at = ?, updated_at = ? WHERE id = ? AND first_pattern_notified_at IS NULL')
    .bind(now, now, userId)
    .run()
  return result.meta.changes > 0
}

async function subscriptionsFor(db: D1Database, userId: string): Promise<PushTarget[]> {
  const { results } = await db
    .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY created_at')
    .bind(userId)
    .all<PushTarget>()
  return results
}

async function forget(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run()
}

export async function announceFirstPattern(
  env: CronBindings,
  userId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const keys = vapidKeysFrom(env)
  // No keys configured (local dev, or a deployment that has not had its secrets set): skip
  // silently and leave the flag unclaimed, so the announcement still happens once they are.
  if (!keys) return false

  const targets = await subscriptionsFor(env.DB, userId)
  // Nobody to tell. Leave the flag alone: the angler may turn notifications on tomorrow, and the
  // first pattern will still be news to them.
  if (targets.length === 0) return false

  if (!(await claimFirstPattern(env.DB, userId, now))) return false

  const payload = {
    title: 'WaterLog found your first pattern',
    body: 'Your fishing just told you something. Tap to see it.',
    url: `${env.APP_URL ?? ''}/patterns`,
    tag: 'first-pattern',
  }

  for (const target of targets) {
    try {
      const result = await sendPush(keys, target, payload, now)
      if (result.expired) await forget(env.DB, target.endpoint)
    } catch (err) {
      // One unreachable browser must not stop the others.
      console.error('cron: push send failed', target.endpoint, err)
    }
  }
  return true
}
