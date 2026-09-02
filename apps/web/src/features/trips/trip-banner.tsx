import { useEffect, useState } from 'react'
import type { LocalTrip, WaterlogDb } from '../../lib/db'
import { getDb } from '../../lib/db'
import type { SyncEngine } from '../../lib/sync/sync-engine'
import { WebSyncEngine } from '../../lib/sync/sync-engine'
import './trip-banner.css'
import { endActiveTrip, getActiveTrip, startTrip } from './trip-lifecycle'

export interface TripBannerProps {
  engine?: SyncEngine
  db?: WaterlogDb
}

/** F2: manual start/stop trip wrapper. GPS auto-detect ("Fishing [Lake Name]? Start trip.") and
 * the 6h-idle/20km-drift auto-end are F2/F5 niceties layered on top of this later — this is the
 * part Epic 1's acceptance criteria actually require: a trip a catch can attach to, including a
 * deliberate zero-catch (skunk) trip. */
export function TripBanner({ engine = new WebSyncEngine(), db = getDb() }: TripBannerProps) {
  const [active, setActive] = useState<LocalTrip | null>(null)

  useEffect(() => {
    void getActiveTrip(db).then(setActive)
  }, [db])

  async function onStart() {
    const trip = await startTrip(engine, db)
    setActive(trip)
    void engine.flush()
  }

  async function onEnd() {
    await endActiveTrip(engine, db)
    setActive(null)
    void engine.flush()
  }

  if (active) {
    return (
      <div role="status" className="trip-banner">
        <span className="trip-banner__status">
          <span className="trip-banner__dot" aria-hidden="true" />
          <span className="trip-banner__text">
            Fishing since{' '}
            <span className="tabular-nums">{new Date(active.started_at).toLocaleTimeString()}</span>
          </span>
        </span>
        <button type="button" className="trip-banner__button trip-banner__button--end" onClick={() => void onEnd()}>
          End trip
        </button>
      </div>
    )
  }

  return (
    <div className="trip-banner">
      <span className="trip-banner__prompt">No active trip</span>
      <button
        type="button"
        className="trip-banner__button trip-banner__button--start"
        onClick={() => void onStart()}
      >
        Start trip
      </button>
    </div>
  )
}
