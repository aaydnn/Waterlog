import type { User } from '@waterlog/schema'
import { useCallback, useEffect, useState } from 'react'
import './app.css'
import { SignIn } from './features/auth/sign-in'
import { CaptureFlow } from './features/capture/capture-flow'
import { Journal } from './features/journal/journal'
import { StatsView } from './features/stats/stats-view'
import { TripBanner } from './features/trips/trip-banner'
import { setUnauthorizedHandler } from './lib/api-client'
import { setActiveUserId } from './lib/auth/active-user'
import type { AuthProvider } from './lib/auth/auth-provider'
import { WebAuthProvider } from './lib/auth/auth-provider'
import { startAutoFlush } from './lib/sync/auto-flush'
import type { SyncEngine } from './lib/sync/sync-engine'
import { WebSyncEngine } from './lib/sync/sync-engine'
import { BottomNav, type AppView } from './ui/bottom-nav'
import { Wordmark } from './ui/wordmark'

export interface AppProps {
  /** Injectable for tests; production always uses the Dexie-backed implementations. */
  engine?: SyncEngine
  auth?: AuthProvider
}

/** 'unknown' is the first paint, before /api/me answers — distinct from 'signed-out' so the
 * sign-in screen never flashes at an angler who is already signed in. */
type SessionState = 'unknown' | 'signed-out' | { user: User }

// Epic 1-3 shell: sign-in gate, trip lifecycle, capture, journal and free-tier stats. Patterns
// (Epic 4) and Briefing (Epic 5) join the nav when they exist.
export function App({ engine, auth = new WebAuthProvider() }: AppProps = {}) {
  const [view, setView] = useState<AppView>('journal')
  const [session, setSession] = useState<SessionState>('unknown')

  const loadSession = useCallback(async () => {
    try {
      const user = await auth.currentUser()
      // Before the queue is touched: rows are stamped with whoever this is, and a flush only
      // sends rows already stamped for them.
      setActiveUserId(user?.id ?? null)
      setSession(user ? { user } : 'signed-out')
    } catch {
      // Offline or the API is down: an existing session is still valid, and the app is
      // offline-first — keep the angler in rather than locking them out of their own journal.
      setSession((current) => (current === 'unknown' ? 'signed-out' : current))
    }
  }, [auth])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  // One place decides what a 401 means, wherever it surfaces: the session is gone, sign in.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setActiveUserId(null)
      setSession('signed-out')
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  // Anything queued while the angler was offline drains on mount, on reconnect, and whenever the
  // app comes back to the foreground — the queue must never depend on them noticing. Only once
  // there's a session: flushing before one would just spend the battery on 401s, and the queue
  // is stamped per user, so it needs to know who is here first.
  const signedIn = typeof session === 'object'
  useEffect(() => {
    if (!signedIn) return
    return startAutoFlush(engine ?? new WebSyncEngine())
  }, [engine, signedIn])

  async function onSignOut() {
    // Deliberately not clearing the queue: unsynced catches belong to the angler who logged
    // them and are stamped with their id, so they wait here for them rather than being lost or
    // handed to whoever signs in next.
    try {
      await auth.signOut()
    } catch {
      // Already gone server-side, or offline — either way this device is done with the session.
    }
    setActiveUserId(null)
    setSession('signed-out')
  }

  if (session === 'unknown') return <div className="app-boot" aria-hidden="true" />
  if (session === 'signed-out') return <SignIn auth={auth} />

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>
          <Wordmark />
        </h1>
        <button type="button" className="app-header__sign-out" onClick={() => void onSignOut()}>
          Sign out
        </button>
      </header>
      <TripBanner />
      {view === 'journal' ? <Journal /> : <StatsView />}
      <CaptureFlow />
      <BottomNav view={view} onChange={setView} />
    </main>
  )
}
