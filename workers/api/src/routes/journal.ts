import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { getCatchDetail, getStats, journalQuery, listJournal } from '../lib/journal'
import { requireAuth } from '../middleware/require-auth'

export const journalRoutes = new Hono<AppEnv>()

// F3: reverse-chron catch list with filters, keyset-paginated.
journalRoutes.get('/', requireAuth, async (c) => {
  const parsed = journalQuery.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: 'invalid journal query' }, 400)

  return c.json(await listJournal(c.env.DB, c.get('user').id, parsed.data))
})

// F3 detail: one catch with its trip, water, lure and enriched conditions.
journalRoutes.get('/:id', requireAuth, async (c) => {
  const detail = await getCatchDetail(c.env.DB, c.get('user').id, c.req.param('id'))
  if (!detail) return c.json({ error: 'not found' }, 404)

  return c.json(detail)
})

export const statsRoutes = new Hono<AppEnv>()

// F4: free-tier totals and breakdowns. No condition correlations — those are Epic 4, behind Pro.
statsRoutes.get('/', requireAuth, async (c) => {
  return c.json(await getStats(c.env.DB, c.get('user').id))
})
