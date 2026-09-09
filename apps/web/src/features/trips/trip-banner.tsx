import { useEffect, useState } from 'react'
import type { WaterBodyKind } from '@waterlog/schema'
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
import { autoCloseReason, suggestedEndAt, SNOOZE_MS, type AutoCloseReason } from './auto-close'
import { endActiveTrip, getActiveTrip, startTrip } from './trip-lifecycle'

export interface TripBannerProps {
  engine?: SyncEngine
  db?: WaterlogDb
}

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

/** Often enough to catch a forgotten trip within the hour, rarely enough that it costs nothing. */
const CHECK_EVERY_MS = 5 * 60 * 1000

/** F2: start/stop trip wrapper, the water the trip is on, and the 6h-idle / 20km-drift
 * auto-close prompt. A trip a catch can attach to, including a deliberate zero-catch (skunk)
 * trip — and one that does not run forever when the angler forgets it. The water matters beyond
 * labelling: enrichment reads the trip's water body to find its pool gauge and its centroid
 * (ADR-0008), so a trip with no water gets weather and astronomy only. */
export function TripBanner({ engine = new WebSyncEngine(), db = getDb() }: TripBannerProps) {
  const [active, setActive] = useState<LocalTrip | null>(null)
  const [waterTempF, setWaterTempF] = useState('')
  const [ranked, setRanked] = useState<RankedWater[]>([])
  const [selectedWaterId, setSelectedWaterId] = useState<string | null>(null)
  const [newWaterName, setNewWaterName] = useState('')
  const [newWaterKind, setNewWaterKind] = useState<WaterBodyKind>('lake')
  const [addingWater, setAddingWater] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [closePrompt, setClosePrompt] = useState<{ reason: AutoCloseReason; endAt: number } | null>(null)

  useEffect(() => {
    void getActiveTrip(db).then(setActive)
  }, [db])

  // F2 auto-close: a trip nobody ended keeps accruing hours it never fished, and hours on water
  // is the denominator every rate in the pattern engine divides by. Checked on mount, every few
  // minutes, and whenever the app comes back to the foreground — which on a phone in a pocket is
  // the moment that actually matters.
  useEffect(() => {
    if (!active) {
      setClosePrompt(null)
      return
    }
    let cancelled = false

    async function check() {
      if (!active) return
      const catches = await db.catches.filter((c) => c.trip_id === active.local_id || c.trip_id === active.id).toArray()
      const lastCatchAt = catches.reduce<number | null>((latest, c) => Math.max(latest ?? 0, c.caught_at) || null, null)
      const water = ranked.find((r) => r.water.id === active.water_body_id)?.water
      const firstCatchWithFix = catches.find((c) => c.lat !== null && c.lng !== null)
      const anchor =
        water?.centroid_lat != null && water.centroid_lng != null
          ? { lat: water.centroid_lat, lng: water.centroid_lng }
          : firstCatchWithFix
            ? { lat: firstCatchWithFix.lat as number, lng: firstCatchWithFix.lng as number }
            : null
      // Only worth a fix when there is something to measure against.
      const position = anchor ? await bestEffortPosition() : null
      if (cancelled) return

      const shared = { startedAt: active.started_at, lastCatchAt, now: Date.now(), position, anchor, snoozedUntil: active.snoozed_until ?? null }
      const reason = autoCloseReason(shared)
      setClosePrompt(reason ? { reason, endAt: suggestedEndAt(shared) } : null)
    }

    void check()
    const timer = setInterval(() => void check(), CHECK_EVERY_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, db, ranked])

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

  /** Ends the trip when it actually stopped, not when we noticed (see suggestedEndAt). */
  async function onConfirmClose() {
    if (!active || !closePrompt) return
    await engine.endTrip(active.local_id, closePrompt.endAt, toCelsius(waterTempF))
    setClosePrompt(null)
    setActive(null)
    setWaterTempF('')
    void engine.flush()
  }

  async function onStillFishing() {
    if (!active) return
    const snoozedUntil = Date.now() + SNOOZE_MS
    await db.trips.update(active.local_id, { snoozed_until: snoozedUntil })
    setActive({ ...active, snoozed_until: snoozedUntil })
    setClosePrompt(null)
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
        kind: newWaterKind,
        centroid_lat: position?.lat ?? null,
        centroid_lng: position?.lng ?? null,
      })
      setRanked(rankByDistance([...ranked.map((r) => r.water), water], position))
      setSelectedWaterId(water.id)
      setNewWaterName('')
      setNewWaterKind('lake')
      setAddingWater(false)
    } catch {
      setAddError('Could not add that water — needs a connection.')
    }
  }

  if (active && closePrompt) {
    const endAtLabel = new Date(closePrompt.endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return (
      <div role="status" className="trip-banner trip-banner--prompt">
        <span className="trip-banner__text">
          {closePrompt.reason === 'idle'
            ? `Nothing logged in a while — did this trip end around ${endAtLabel}?`
            : `You're a way from ${activeWaterName ?? 'the water'} — did this trip end around ${endAtLabel}?`}
        </span>
        <div className="trip-banner__prompt-actions">
          <button
            type="button"
            className="trip-banner__button trip-banner__button--start"
            onClick={() => void onConfirmClose()}
          >
            End at {endAtLabel}
          </button>
          <button
            type="button"
            className="trip-banner__button trip-banner__button--end"
            onClick={() => void onStillFishing()}
          >
            Still fishing
          </button>
        </div>
      </div>
    )
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
            {/* Not cosmetic: enrichment only looks for a flow gauge on moving water, because
                discharge is a river measurement and the nearest gauge to a lake is someone
                else's creek (ADR-0010). */}
            <select
              aria-label="Kind of water"
              className="trip-banner__water-select"
              value={newWaterKind}
              onChange={(e) => setNewWaterKind(e.target.value as WaterBodyKind)}
            >
              <option value="lake">Lake</option>
              <option value="reservoir">Reservoir</option>
              <option value="pond">Pond</option>
              <option value="river">River</option>
              <option value="saltwater">Saltwater</option>
            </select>
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
