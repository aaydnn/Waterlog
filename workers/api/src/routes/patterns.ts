import { pushSubscriptionInputSchema } from '@waterlog/schema'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { newId } from '../lib/ids'
import { getPatternFeed } from '../lib/patterns'
import { waterBodyExists } from '../lib/water-bodies'
import { expectUser } from '../middleware/expect-user'
import { requireAuth } from '../middleware/require-auth'

export const patternRoutes = new Hono<AppEnv>()

const feedQuery = z.object({ scope: z.string().min(1).optional() })

// F6: the pattern feed, read straight out of pattern_cache. Free anglers get the true count and a
// redacted card; the redaction happens in getPatternFeed, on this side of the wire (ADR-0016).
patternRoutes.get('/', requireAuth, expectUser, async (c) => {
  const parsed = feedQuery.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: 'invalid pattern query' }, 400)

  const user = c.get('user')
  const scope = parsed.data.scope ?? null
  // A scope naming a water is checked for ownership first, so a guessed id cannot be used to
  // probe whether another angler's water exists.
  if (scope !== null && scope !== 'all' && !(await waterBodyExists(c.env.DB, user.id, scope))) {
    return c.json({ error: 'water not found' }, 404)
  }

  return c.json(await getPatternFeed(c.env.DB, user.id, user.tier, { scope }))
})

export const pushRoutes = new Hono<AppEnv>()

// The application server key a browser needs before it can subscribe. Served rather than compiled
// into the bundle so rotating the keypair is a secret change, not a rebuild. A 503 is the honest
// answer when push is not configured: the client then never prompts for a permission it could not
// act on.
pushRoutes.get('/key', requireAuth, async (c) => {
  const key = c.env.VAPID_PUBLIC_KEY
  if (!key) return c.json({ error: 'push is not configured' }, 503)
  return c.json({ key })
})

// Where a browser registers for Web Push. Idempotent on the endpoint the push service issued, so
// a client that re-subscribes on every load does not accumulate rows.
pushRoutes.post('/subscriptions', requireAuth, expectUser, async (c) => {
  const parsed = pushSubscriptionInputSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid subscription' }, 400)

  const userId = c.get('user').id
  const { endpoint, p256dh, auth } = parsed.data
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       -- A browser that signs a different angler in re-points the same endpoint at them; the keys
       -- rotate with it, and the row stays one per browser.
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(newId(), userId, endpoint, p256dh, auth, Date.now())
    .run()

  return c.json({ ok: true }, 201)
})

pushRoutes.delete('/subscriptions', requireAuth, expectUser, async (c) => {
  const parsed = z
    .object({ endpoint: z.string().min(1).max(2048) })
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid subscription' }, 400)

  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .bind(parsed.data.endpoint, c.get('user').id)
    .run()
  return c.json({ ok: true })
})
