import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { createLure, listLures, lureCreateInput } from '../lib/lures'
import { requireAuth } from '../middleware/require-auth'

export const lureRoutes = new Hono<AppEnv>()

lureRoutes.get('/', requireAuth, async (c) => {
  const lures = await listLures(c.env.DB, c.get('user').id)
  return c.json({ lures })
})

lureRoutes.post('/', requireAuth, async (c) => {
  const parsed = lureCreateInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid lure' }, 400)

  const lure = await createLure(c.env.DB, c.get('user').id, parsed.data)
  return c.json({ lure }, 201)
})
