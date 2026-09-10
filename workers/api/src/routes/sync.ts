import type { Catch, Trip } from '@waterlog/schema'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { catchCreateInput, upsertCatchByClientId } from '../lib/catches'
import { dispatchBudget, enqueueEnrichment, enqueueTripHours } from '../lib/enrichment'
import { lureExists } from '../lib/lures'
import { expectUser } from '../middleware/expect-user'
import { requireAuth } from '../middleware/require-auth'
import {
  clampTripEnd,
  getTripById,
  tripCreateInput,
  upsertOrphanTrip,
  upsertTripByClientId,
  validateTimestamp,
  validateTripTimes,
} from '../lib/trips'
import { waterBodyExists } from '../lib/water-bodies'

/**
 * Batch ceilings. Every row in a batch costs a write and, for most, an outbound enrichment job,
 * so an unbounded array is a work amplifier handed to the client. The numbers are sized to the
 * worst *honest* case — a season's backlog flushed after months offline — with an order of
 * magnitude to spare: 200 trips is more outings than the heaviest persona fishes in a year
 * (packet §03: 8–20 days/yr), and 500 catches is ~1.4 hours of continuous 10-second captures.
 * A client with more than this to flush pages it; a client that can't is not a client.
 */
const MAX_TRIPS_PER_BATCH = 200
const MAX_CATCHES_PER_BATCH = 500
/** 1 MiB. Notes and species slugs are small; nothing legitimate approaches this. */
const MAX_BODY_BYTES = 1024 * 1024

const syncRequestSchema = z.object({
  trips: z.array(tripCreateInput).max(MAX_TRIPS_PER_BATCH).default([]),
  catches: z.array(catchCreateInput).max(MAX_CATCHES_PER_BATCH).default([]),
})

interface SyncError {
  client_id: string
  message: string
}

export const syncRoutes = new Hono<AppEnv>()

// Idempotent batch sync (ADR-0003, packet §05/§10): dedupes trips and catches on client_id,
// so replaying a batch never duplicates. Trips are applied first so same-batch catches can
// reference a trip by its client_id (the server id doesn't exist on the client yet). A catch
// with no trip_id at all is an orphan capture (F2) and gets a synthetic 1h trip.
syncRoutes.post('/', requireAuth, expectUser, async (c) => {
  // Measured before parsing, not after: a body we refuse should never be turned into objects.
  // UTF-8 is never shorter than the string's UTF-16 length, so this is a safe under-estimate.
  const declared = Number(c.req.header('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return c.json({ error: 'sync batch too large', message: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
  }
  const raw = await c.req.text().catch(() => null)
  if (raw !== null && raw.length > MAX_BODY_BYTES) {
    return c.json({ error: 'sync batch too large', message: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
  }

  let body: unknown = null
  try {
    body = raw === null ? null : JSON.parse(raw)
  } catch {
    body = null
  }

  const parsed = syncRequestSchema.safeParse(body)
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.code === 'too_big')) {
      return c.json(
        {
          error: 'sync batch too large',
          message: `at most ${MAX_TRIPS_PER_BATCH} trips and ${MAX_CATCHES_PER_BATCH} catches per request`,
        },
        400,
      )
    }
    return c.json({ error: 'invalid sync batch' }, 400)
  }
  const { trips, catches } = parsed.data
  const user = c.get('user')
  const db = c.env.DB
  const now = Date.now()
  // One count for the whole batch: the per-account ceiling on enrichment jobs in flight.
  const budget = await dispatchBudget(db, user.id, now)

  const resultTrips: Trip[] = []
  const errors: SyncError[] = []
  const clientTripIds = new Map<string, string>() // this batch's trip client_id -> server trip id
  for (const tripInput of trips) {
    // Impossible timestamps are a per-item error; an over-long trip is clamped, never rejected.
    // Rejecting it would take every catch referencing it by client_id down with it, with no way
    // for the client to correct the batch (see clampTripEnd).
    const timeProblem = validateTripTimes(tripInput.started_at, tripInput.ended_at, now)
    if (timeProblem) {
      errors.push({ client_id: tripInput.client_id, message: timeProblem })
      continue
    }
    const endedAt = clampTripEnd(tripInput.started_at, tripInput.ended_at)
    if (endedAt !== tripInput.ended_at) {
      console.warn('sync: clamping over-long trip', tripInput.client_id, tripInput.ended_at, '->', endedAt)
    }
    // The FK only proves the water exists, not that this angler owns it — check before the row
    // is written rather than letting a trip point at someone else's water.
    if (tripInput.water_body_id && !(await waterBodyExists(db, user.id, tripInput.water_body_id))) {
      errors.push({ client_id: tripInput.client_id, message: `water_body_id ${tripInput.water_body_id} not found` })
      continue
    }
    const { row: trip } = await upsertTripByClientId(db, user.id, { ...tripInput, ended_at: endedAt })
    clientTripIds.set(tripInput.client_id, trip.id)
    resultTrips.push(trip)
  }

  const resultCatches: Catch[] = []
  for (const catchInput of catches) {
    // caught_at fans out too: an orphan catch mints a trip around it, and enrichment looks the
    // hour up in the weather archive.
    const timeProblem = validateTimestamp('caught_at', catchInput.caught_at, now)
    if (timeProblem) {
      errors.push({ client_id: catchInput.client_id, message: timeProblem })
      continue
    }
    // Same ownership rule as water bodies: a foreign lure_id would otherwise be stored and read
    // back through the journal's join as another angler's lure name.
    if (catchInput.lure_id && !(await lureExists(db, user.id, catchInput.lure_id))) {
      errors.push({ client_id: catchInput.client_id, message: `lure_id ${catchInput.lure_id} not found` })
      continue
    }

    let tripId: string

    if (catchInput.trip_id) {
      const fromBatch = clientTripIds.get(catchInput.trip_id)
      if (fromBatch) {
        tripId = fromBatch
      } else {
        const existing = await getTripById(db, user.id, catchInput.trip_id)
        if (!existing) {
          errors.push({ client_id: catchInput.client_id, message: `trip_id ${catchInput.trip_id} not found` })
          continue
        }
        tripId = existing.id
      }
    } else {
      const { row: orphan } = await upsertOrphanTrip(db, user.id, catchInput.client_id, catchInput.caught_at)
      resultTrips.push(orphan)
      tripId = orphan.id
    }

    const { row: catchRow } = await upsertCatchByClientId(db, user.id, tripId, catchInput)
    resultCatches.push(catchRow)
    await enqueueEnrichment(db, c.env.ENRICH_QUEUE, user.id, { type: 'catch', catch_id: catchRow.id }, budget)
  }

  // Dispatch after catches are persisted so trips without a water-body centroid
  // can use a same-batch catch's coordinates, including synthetic orphan trips.
  for (const trip of resultTrips) await enqueueTripHours(db, c.env.ENRICH_QUEUE, trip, budget)

  return c.json({ trips: resultTrips, catches: resultCatches, errors })
})
