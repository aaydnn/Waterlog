import { useEffect, useState } from 'react'
import './app.css'
import { CaptureFlow } from './features/capture/capture-flow'
import { Journal } from './features/journal/journal'
import { StatsView } from './features/stats/stats-view'
import { TripBanner } from './features/trips/trip-banner'
import { startAutoFlush } from './lib/sync/auto-flush'
import type { SyncEngine } from './lib/sync/sync-engine'
import { WebSyncEngine } from './lib/sync/sync-engine'
import { BottomNav, type AppView } from './ui/bottom-nav'
import { Wordmark } from './ui/wordmark'

export interface AppProps {
  /** Injectable for tests; production always uses the Dexie-backed engine. */
  engine?: SyncEngine
}

// Epic 1-3 shell: trip lifecycle, capture, journal and free-tier stats. Patterns (Epic 4) and
// Briefing (Epic 5) join the nav when they exist.
export function App({ engine }: AppProps = {}) {
  const [view, setView] = useState<AppView>('journal')

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
      {view === 'journal' ? <Journal /> : <StatsView />}
      <CaptureFlow />
      <BottomNav view={view} onChange={setView} />
    </main>
  )
}
