import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../env'

/** Header a client sends to name the account it believes it is syncing as. */
export const EXPECTED_USER_HEADER = 'X-Waterlog-User'

/**
 * Binds a write request to the account the client thinks it is signed in as.
 *
 * The offline queue holds rows captured by whoever was signed in when they were captured. If the
 * session cookie has since changed accounts — a shared device, a re-auth as someone else — an
 * unqualified flush would write one angler's catches into another's journal. The client stamps
 * the request with the user id it queued for; we refuse the write when that disagrees with the
 * session rather than silently re-homing the data.
 *
 * Must run after `requireAuth` — it reads `c.get('user')`. The header is optional: clients
 * deployed before this contract existed don't send it and keep working as before.
 */
export const expectUser = createMiddleware<AppEnv>(async (c, next) => {
  const expected = c.req.header(EXPECTED_USER_HEADER)
  if (expected !== undefined && expected !== c.get('user').id) {
    return c.json({ error: 'session_mismatch' }, 409)
  }
  await next()
})
