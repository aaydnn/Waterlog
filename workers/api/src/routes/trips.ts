import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { enqueueTripHours } from '../lib/enrichment'
import { endTrip } from '../lib/trips'
import { requireAuth } from '../middleware/require-auth'

export const tripRoutes = new Hono<AppEnv>()

// water_temp_c is the angler's own reading, taken any time during the trip and sent when it
// ends. Optional: a trip without one still enriches, using the modeled estimate (ADR-0008).
const endTripInput = z.object({
  ended_at: z.number().int(),
  water_temp_c: z.number().nullish(),
})

tripRoutes.patch('/:id/end', requireAuth, async (c) => {
  const parsed = endTripInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400)

  const result = await endTrip(c.env.DB, c.get('user').id, c.req.param('id'), parsed.data.ended_at, parsed.data.water_temp_c ?? null)
  if (!result) return c.json({ error: 'trip not found' }, 404)
  const { row: trip } = result

  await enqueueTripHours(c.env.DB, c.env.ENRICH_QUEUE, trip)

  return c.json({ trip })
})
