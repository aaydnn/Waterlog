import { useEffect, useState } from 'react'
import type { LocalTrip, WaterlogDb } from '../../lib/db'
import { getDb } from '../../lib/db'
import { bestEffortPosition } from '../../lib/geo'
import type { SyncEngine } from '../../lib/sync/sync-engine'
import { WebSyncEngine } from '../../lib/sync/sync-engine'
import {
  createWaterBody,
  defaultWaterId,
  NEAR_WATER_KM,
  rankByDistance,
  syncWaterBodies,
  type RankedWater,
} from '../../lib/water-bodies'
import './trip-banner.css'
import { endActiveTrip, getActiveTrip, startTrip } from './trip-lifecycle'

export interface TripBannerProps {
  engine?: SyncEngine
  db?: WaterlogDb
}

/** F2: manual start/stop trip wrapper, with the water the trip is on. The 6h-idle/20km-drift
 * auto-end is an F2/F5 nicety layered on later — this is the part Epic 1's acceptance criteria
 * actually require: a trip a catch can attach to, including a deliberate zero-catch (skunk)
 * trip. The water matters beyond labelling: enrichment reads the trip's water body to find its
 * pool gauge and its centroid (ADR-0008), so a trip with no water gets weather and astronomy
 * only. */
/** US anglers read water temp in Fahrenheit; `conditions` stores Celsius like every other
 * temperature. Returns null for blank or nonsense input rather than poisoning the row. */
function toCelsius(fahrenheit: string): number | null {
  const trimmed = fahrenheit.trim()
  if (trimmed === '') return null
  const f = Number(trimmed)
  if (!Number.isFinite(f) || f < 32 || f > 110) return null
  return Math.round(((f - 32) / 1.8) * 10) / 10
}

const NEW_WATER = '__new__'

export function TripBanner({ engine = new WebSyncEngine(), db = getDb() }: TripBannerProps) {
  const [active, setActive] = useState<LocalTrip | null>(null)
  const [waterTempF, setWaterTempF] = useState('')
  const [ranked, setRanked] = useState<RankedWater[]>([])
  const [selectedWaterId, setSelectedWaterId] = useState<string | null>(null)
  const [newWaterName, setNewWaterName] = useState('')
  const [addingWater, setAddingWater] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    void getActiveTrip(db).then(setActive)
  }, [db])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // The cached list renders first; the GPS fix only re-orders it, so the picker is usable
      // immediately even where location is denied or slow.
      const waters = await syncWaterBodies(db)
      if (cancelled) return
      setRanked(rankByDistance(waters, null))

      const position = await bestEffortPosition()
      if (cancelled) return
      const byDistance = rankByDistance(waters, position)
      setRanked(byDistance)
      setSelectedWaterId((current) => current ?? defaultWaterId(byDistance))
    })()
    return () => {
      cancelled = true
    }
  }, [db])

  const nearest = ranked[0]
  const atNearest = nearest && nearest.km !== null && nearest.km <= NEAR_WATER_KM ? nearest.water : null
  const activeWaterName = ranked.find((r) => r.water.id === active?.water_body_id)?.water.name ?? null

  async function onStart() {
    const trip = await startTrip(engine, db, selectedWaterId)
    setActive(trip)
    void engine.flush()
  }

  async function onEnd() {
    await endActiveTrip(engine, db, toCelsius(waterTempF))
    setActive(null)
    setWaterTempF('')
    void engine.flush()
  }

  async function onAddWater() {
    const name = newWaterName.trim()
    if (name === '') return
    setAddError(null)
    // The fix is the whole point of adding a water here — it becomes the centroid enrichment
    // falls back to, and what ranks this water next time.
    const position = await bestEffortPosition()
    try {
      const water = await createWaterBody(db, {
        name,
        centroid_lat: position?.lat ?? null,
        centroid_lng: position?.lng ?? null,
      })
      setRanked(rankByDistance([...ranked.map((r) => r.water), water], position))
      setSelectedWaterId(water.id)
      setNewWaterName('')
      setAddingWater(false)
    } catch {
      setAddError('Could not add that water — needs a connection.')
    }
  }

  if (active) {
    return (
      <div role="status" className="trip-banner">
        <span className="trip-banner__status">
          <span className="trip-banner__dot" aria-hidden="true" />
          <span className="trip-banner__text">
            {activeWaterName ? `Fishing ${activeWaterName} since ` : 'Fishing since '}
            <span className="tabular-nums">{new Date(active.started_at).toLocaleTimeString()}</span>
          </span>
        </span>
        {/* Optional, and deliberately not in the capture flow: F1's ten-second capture is an
            acceptance criterion, so the numeric input lives here where there's no time pressure.
            One reading per outing is how anglers actually record it (ADR-0008). */}
        <label className="trip-banner__temp">
          <span className="trip-banner__temp-label">Water</span>
          <input
            type="number"
            inputMode="decimal"
            className="trip-banner__temp-input"
            placeholder="--"
            aria-label="Water temperature in Fahrenheit"
            value={waterTempF}
            onChange={(e) => setWaterTempF(e.target.value)}
          />
          <span className="trip-banner__temp-unit" aria-hidden="true">
            °F
          </span>
        </label>
        <button type="button" className="trip-banner__button trip-banner__button--end" onClick={() => void onEnd()}>
          End trip
        </button>
      </div>
    )
  }

  return (
    <div className="trip-banner trip-banner--idle">
      <span className="trip-banner__prompt">
        {atNearest ? `Fishing ${atNearest.name}?` : 'No active trip'}
      </span>

      <div className="trip-banner__water">
        <select
          aria-label="Water"
          className="trip-banner__water-select"
          value={addingWater ? NEW_WATER : (selectedWaterId ?? '')}
          onChange={(e) => {
            const value = e.target.value
            if (value === NEW_WATER) {
              setAddingWater(true)
              return
            }
            setAddingWater(false)
            setSelectedWaterId(value === '' ? null : value)
          }}
        >
          <option value="">No water</option>
          {ranked.map(({ water }) => (
            <option key={water.id} value={water.id}>
              {water.name}
            </option>
          ))}
          <option value={NEW_WATER}>+ New water…</option>
        </select>

        {addingWater && (
          <>
            <input
              className="trip-banner__water-input"
              aria-label="New water name"
              placeholder="Name this water"
              value={newWaterName}
              onChange={(e) => setNewWaterName(e.target.value)}
            />
            <button type="button" className="trip-banner__button trip-banner__button--end" onClick={() => void onAddWater()}>
              Add
            </button>
          </>
        )}
      </div>

      {addError && <span className="trip-banner__error">{addError}</span>}

      <button type="button" className="trip-banner__button trip-banner__button--start" onClick={() => void onStart()}>
        Start trip
      </button>
    </div>
  )
}
