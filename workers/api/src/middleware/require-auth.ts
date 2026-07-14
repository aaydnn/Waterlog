import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../env'
import { readSessionCookie } from '../lib/session-cookie'
import { validateSession } from '../lib/sessions'
import { getUserById } from '../lib/users'

/** Resolves the session cookie to a user and attaches it to the context;
 * 401s when the cookie is missing, unknown, or expired. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = readSessionCookie(c)
  if (!token) return c.json({ error: 'unauthorized' }, 401)

  const session = await validateSession(c.env.DB, token)
  if (!session) return c.json({ error: 'unauthorized' }, 401)

  const user = await getUserById(c.env.DB, session.user_id)
  if (!user) return c.json({ error: 'unauthorized' }, 401)

  c.set('user', user)
  await next()
})
