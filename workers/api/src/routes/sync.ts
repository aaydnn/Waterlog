import type { Catch, Trip } from '@waterlog/schema'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { catchCreateInput, upsertCatchByClientId } from '../lib/catches'
import { requireAuth } from '../middleware/require-auth'
import { createOrphanTrip, getTripById, tripCreateInput, upsertTripByClientId } from '../lib/trips'

const syncRequestSchema = z.object({
  trips: z.array(tripCreateInput).default([]),
  catches: z.array(catchCreateInput).default([]),
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
syncRoutes.post('/', requireAuth, async (c) => {
  const parsed = syncRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid sync batch' }, 400)
  const { trips, catches } = parsed.data
  const user = c.get('user')
  const db = c.env.DB

  const resultTrips: Trip[] = []
  const clientTripIds = new Map<string, string>() // this batch's trip client_id -> server trip id
  for (const tripInput of trips) {
    const trip = await upsertTripByClientId(db, user.id, tripInput)
    clientTripIds.set(tripInput.client_id, trip.id)
    resultTrips.push(trip)
  }

  const resultCatches: Catch[] = []
  const errors: SyncError[] = []
  for (const catchInput of catches) {
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
      const orphan = await createOrphanTrip(db, user.id, catchInput.caught_at)
      resultTrips.push(orphan)
      tripId = orphan.id
    }

    resultCatches.push(await upsertCatchByClientId(db, user.id, tripId, catchInput))
  }

  return c.json({ trips: resultTrips, catches: resultCatches, errors })
})
