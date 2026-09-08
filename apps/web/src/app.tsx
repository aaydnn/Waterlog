import { useEffect } from 'react'
import './app.css'
import { CaptureFlow } from './features/capture/capture-flow'
import { TripBanner } from './features/trips/trip-banner'
import { startAutoFlush } from './lib/sync/auto-flush'
import type { SyncEngine } from './lib/sync/sync-engine'
import { WebSyncEngine } from './lib/sync/sync-engine'
import { Wordmark } from './ui/wordmark'

export interface AppProps {
  /** Injectable for tests; production always uses the Dexie-backed engine. */
  engine?: SyncEngine
}

// Epic 1 shell: trip lifecycle + capture flow. Journal/Patterns/Briefing (F3-F9) are later
// epics — no bottom nav yet, there's nothing for it to navigate to.
export function App({ engine }: AppProps = {}) {
  // Anything queued while offline or signed out drains on mount, on reconnect, and whenever the
  // app comes back to the foreground — the queue must never depend on the angler noticing.
  useEffect(() => startAutoFlush(engine ?? new WebSyncEngine()), [engine])

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>
          <Wordmark />
        </h1>
      </header>
      <TripBanner />
      <CaptureFlow />
    </main>
  )
}
