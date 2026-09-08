import type { CatchDetail, JournalEntry, JournalPage, Stats } from '@waterlog/schema'
import { z } from 'zod'

export const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100

export const journalQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
  species: z.string().optional(),
  water_body_id: z.string().optional(),
  lure_id: z.string().optional(),
  /** Inclusive epoch-ms bounds on caught_at. */
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
})
export type JournalQuery = z.infer<typeof journalQuery>

/** Keyset cursor: the last row's (caught_at, id). Offsets would skip or repeat rows as new
 * catches land at the top of a reverse-chron list, which is the normal case here. */
function encodeCursor(entry: JournalEntry): string {
  return `${entry.caught_at}.${entry.id}`
}

function decodeCursor(cursor: string): { caught_at: number; id: string } | null {
  const dot = cursor.indexOf('.')
  if (dot <= 0) return null
  const caught_at = Number(cursor.slice(0, dot))
  const id = cursor.slice(dot + 1)
  if (!Number.isFinite(caught_at) || id === '') return null
  return { caught_at, id }
}

const ENTRY_SELECT = `
  SELECT c.id, c.caught_at, c.species, c.photo_key, c.length_mm, c.weight_g, c.released, c.notes,
         c.enrich_status, c.lure_id, l.name AS lure_name,
         c.trip_id, t.water_body_id, w.name AS water_body_name
  FROM catches c
  JOIN trips t ON t.id = c.trip_id
  LEFT JOIN lures l ON l.id = c.lure_id
  LEFT JOIN water_bodies w ON w.id = t.water_body_id
  WHERE c.user_id = ? AND c.deleted_at IS NULL`

/** F3: reverse-chron page of catches with the names a card shows. */
export async function listJournal(db: D1Database, userId: string, query: JournalQuery): Promise<JournalPage> {
  const conditions: string[] = []
  const binds: unknown[] = [userId]

  if (query.species) {
    conditions.push('c.species = ?')
    binds.push(query.species)
  }
  if (query.water_body_id) {
    conditions.push('t.water_body_id = ?')
    binds.push(query.water_body_id)
  }
  if (query.lure_id) {
    conditions.push('c.lure_id = ?')
    binds.push(query.lure_id)
  }
  if (query.from !== undefined) {
    conditions.push('c.caught_at >= ?')
    binds.push(query.from)
  }
  if (query.to !== undefined) {
    conditions.push('c.caught_at <= ?')
    binds.push(query.to)
  }

  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  if (cursor) {
    // Strictly "older than the last row we sent", tie-broken by id so a same-millisecond pair
    // can never be shown twice or skipped.
    conditions.push('(c.caught_at < ? OR (c.caught_at = ? AND c.id < ?))')
    binds.push(cursor.caught_at, cursor.caught_at, cursor.id)
  }

  const where = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''
  // One extra row tells us whether another page exists without a second COUNT query.
  const { results } = await db
    .prepare(`${ENTRY_SELECT}${where} ORDER BY c.caught_at DESC, c.id DESC LIMIT ?`)
    .bind(...binds, query.limit + 1)
    .all<JournalEntry>()

  const hasMore = results.length > query.limit
  const entries = hasMore ? results.slice(0, query.limit) : results
  const last = entries[entries.length - 1]
  return { entries, next_cursor: hasMore && last ? encodeCursor(last) : null }
}

/** F3 detail: the catch, its trip and water, the lure, and the enriched conditions row. */
export async function getCatchDetail(db: D1Database, userId: string, catchId: string): Promise<CatchDetail | null> {
  const catchRow = await db
    .prepare('SELECT * FROM catches WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(catchId, userId)
    .first<CatchDetail['catch']>()
  if (!catchRow) return null

  const trip = await db
    .prepare('SELECT * FROM trips WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(catchRow.trip_id, userId)
    .first<NonNullable<CatchDetail['trip']>>()

  const water_body = trip?.water_body_id
    ? await db
        .prepare('SELECT * FROM water_bodies WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
        .bind(trip.water_body_id, userId)
        .first<NonNullable<CatchDetail['water_body']>>()
    : null

  const lure = catchRow.lure_id
    ? await db
        .prepare('SELECT * FROM lures WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
        .bind(catchRow.lure_id, userId)
        .first<NonNullable<CatchDetail['lure']>>()
    : null

  const conditions = await db
    .prepare('SELECT * FROM conditions WHERE catch_id = ? AND user_id = ?')
    .bind(catchId, userId)
    .first<NonNullable<CatchDetail['conditions']>>()

  return { catch: catchRow, trip: trip ?? null, water_body: water_body ?? null, lure, conditions }
}

const HOUR_MS = 60 * 60 * 1000

/** F4, free tier: totals and simple breakdowns. Every number here has to reconcile with a raw
 * SQL spot-check (packet §10), so each one is a single aggregate over the same base predicate
 * — not a derived or cached figure. */
export async function getStats(db: D1Database, userId: string): Promise<Stats> {
  const totalsRow = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM catches WHERE user_id = ?1 AND deleted_at IS NULL) AS catches,
         (SELECT COUNT(*) FROM trips WHERE user_id = ?1 AND deleted_at IS NULL) AS trips,
         (SELECT COALESCE(SUM(ended_at - started_at), 0) FROM trips
            WHERE user_id = ?1 AND deleted_at IS NULL AND ended_at IS NOT NULL) AS ms_on_water,
         (SELECT COUNT(*) FROM trips t
            WHERE t.user_id = ?1 AND t.deleted_at IS NULL AND t.ended_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM catches c
                              WHERE c.trip_id = t.id AND c.deleted_at IS NULL)) AS skunked_trips,
         (SELECT COUNT(DISTINCT species) FROM catches WHERE user_id = ?1 AND deleted_at IS NULL) AS species,
         (SELECT COUNT(*) FROM water_bodies WHERE user_id = ?1 AND deleted_at IS NULL) AS waters`,
    )
    .bind(userId)
    .first<{
      catches: number
      trips: number
      ms_on_water: number
      skunked_trips: number
      species: number
      waters: number
    }>()

  const bySpecies = await db
    .prepare(
      `SELECT species, COUNT(*) AS catches FROM catches
       WHERE user_id = ? AND deleted_at IS NULL
       GROUP BY species ORDER BY catches DESC, species ASC`,
    )
    .bind(userId)
    .all<{ species: string; catches: number }>()

  // Months are the angler's local months only to the extent the device agrees with UTC; the
  // worker has no timezone. Bucketing in UTC keeps the number reproducible from raw SQL, which
  // is what the acceptance criterion checks.
  const byMonth = await db
    .prepare(
      `SELECT month, SUM(catches) AS catches, SUM(trips) AS trips FROM (
         SELECT strftime('%Y-%m', caught_at / 1000, 'unixepoch') AS month, COUNT(*) AS catches, 0 AS trips
           FROM catches WHERE user_id = ?1 AND deleted_at IS NULL GROUP BY month
         UNION ALL
         SELECT strftime('%Y-%m', started_at / 1000, 'unixepoch') AS month, 0 AS catches, COUNT(*) AS trips
           FROM trips WHERE user_id = ?1 AND deleted_at IS NULL GROUP BY month
       ) GROUP BY month ORDER BY month DESC`,
    )
    .bind(userId)
    .all<{ month: string; catches: number; trips: number }>()

  // Trips are counted per water, catches through their trip — so a catch always lands on the
  // same water as the trip it belongs to, including the "no water" bucket.
  const byWater = await db
    .prepare(
      `SELECT t.water_body_id AS water_body_id, w.name AS water_body_name,
              COUNT(DISTINCT t.id) AS trips,
              COUNT(c.id) AS catches
       FROM trips t
       LEFT JOIN water_bodies w ON w.id = t.water_body_id
       LEFT JOIN catches c ON c.trip_id = t.id AND c.deleted_at IS NULL
       WHERE t.user_id = ? AND t.deleted_at IS NULL
       GROUP BY t.water_body_id, w.name
       ORDER BY catches DESC, trips DESC`,
    )
    .bind(userId)
    .all<{ water_body_id: string | null; water_body_name: string | null; trips: number; catches: number }>()

  return {
    totals: {
      catches: totalsRow?.catches ?? 0,
      trips: totalsRow?.trips ?? 0,
      hours_on_water: Math.round(((totalsRow?.ms_on_water ?? 0) / HOUR_MS) * 10) / 10,
      skunked_trips: totalsRow?.skunked_trips ?? 0,
      species: totalsRow?.species ?? 0,
      waters: totalsRow?.waters ?? 0,
    },
    by_species: bySpecies.results,
    by_month: byMonth.results,
    by_water: byWater.results.map((r) => ({
      water_body_id: r.water_body_id,
      water_body_name: r.water_body_name,
      catches: r.catches,
      trips: r.trips,
    })),
  }
}
