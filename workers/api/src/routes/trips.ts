import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { enqueueTripHours } from '../lib/enrichment'
import { endTrip } from '../lib/trips'
import { requireAuth } from '../middleware/require-auth'

export const tripRoutes = new Hono<AppEnv>()

const endTripInput = z.object({ ended_at: z.number().int() })

tripRoutes.patch('/:id/end', requireAuth, async (c) => {
  const parsed = endTripInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400)

  const result = await endTrip(c.env.DB, c.get('user').id, c.req.param('id'), parsed.data.ended_at)
  if (!result) return c.json({ error: 'trip not found' }, 404)
  const { row: trip } = result

  await enqueueTripHours(c.env.DB, c.env.ENRICH_QUEUE, trip)

  return c.json({ trip })
})
