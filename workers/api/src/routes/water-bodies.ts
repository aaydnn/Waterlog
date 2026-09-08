import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { createWaterBody, listWaterBodies, waterBodyCreateInput } from '../lib/water-bodies'
import { requireAuth } from '../middleware/require-auth'

export const waterBodyRoutes = new Hono<AppEnv>()

waterBodyRoutes.get('/', requireAuth, async (c) => {
  const water_bodies = await listWaterBodies(c.env.DB, c.get('user').id)
  return c.json({ water_bodies })
})

waterBodyRoutes.post('/', requireAuth, async (c) => {
  const parsed = waterBodyCreateInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid water body' }, 400)

  const water_body = await createWaterBody(c.env.DB, c.get('user').id, parsed.data)
  return c.json({ water_body }, 201)
})
