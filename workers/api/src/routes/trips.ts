import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { dispatchBudget, enqueueTripHours } from '../lib/enrichment'
import { clampTripEnd, endTrip, getTripById, validateTripTimes } from '../lib/trips'
import { expectUser } from '../middleware/expect-user'
import { requireAuth } from '../middleware/require-auth'

export const tripRoutes = new Hono<AppEnv>()

// water_temp_c is the angler's own reading, taken any time during the trip and sent when it
// ends. Optional: a trip without one still enriches, using the modeled estimate (ADR-0008).
const endTripInput = z.object({
  ended_at: z.number().int(),
  water_temp_c: z.number().nullish(),
})

tripRoutes.patch('/:id/end', requireAuth, expectUser, async (c) => {
  const parsed = endTripInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400)

  const userId = c.get('user').id
  const existing = await getTripById(c.env.DB, userId, c.req.param('id'))
  if (!existing) return c.json({ error: 'trip not found' }, 404)

  const timeProblem = validateTripTimes(existing.started_at, parsed.data.ended_at)
  if (timeProblem) return c.json({ error: 'invalid trip times', message: timeProblem }, 400)

  // The same ceiling sync applies, enforced here too: without it a trip opened months ago is
  // closed "now" and bills a year of hourly enrichment to one PATCH. Clamped rather than
  // refused — the angler who forgot to close Tuesday's trip taps "End trip" and the client sends
  // `Date.now()`; a 400 would leave that trip open forever (see clampTripEnd).
  const endedAt = clampTripEnd(existing.started_at, parsed.data.ended_at) ?? parsed.data.ended_at
  if (endedAt !== parsed.data.ended_at) {
    console.warn('trips: clamping over-long trip', existing.id, parsed.data.ended_at, '->', endedAt)
  }

  const result = await endTrip(c.env.DB, userId, existing.id, endedAt, parsed.data.water_temp_c ?? null)
  if (!result) return c.json({ error: 'trip not found' }, 404)
  const { row: trip } = result

  await enqueueTripHours(c.env.DB, c.env.ENRICH_QUEUE, trip, await dispatchBudget(c.env.DB, userId))

  return c.json({ trip })
})
