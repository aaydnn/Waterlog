import type { User } from '@waterlog/schema'
import { useCallback, useEffect, useRef, useState } from 'react'
import './app.css'
import { SignIn } from './features/auth/sign-in'
import { CaptureFlow } from './features/capture/capture-flow'
import { Journal } from './features/journal/journal'
import { StatsView } from './features/stats/stats-view'
import { TripBanner } from './features/trips/trip-banner'
import { ApiError, setSessionMismatchHandler, setUnauthorizedHandler } from './lib/api-client'
import { setActiveUserId } from './lib/auth/active-user'
import type { AuthProvider } from './lib/auth/auth-provider'
import { WebAuthProvider } from './lib/auth/auth-provider'
import { clearLogoutPending, isLogoutPending, markLogoutPending } from './lib/auth/pending-revocation'
import { publishSessionChange, subscribeToSessionChanges } from './lib/auth/session-channel'
import { startAutoFlush } from './lib/sync/auto-flush'
import type { SyncEngine } from './lib/sync/sync-engine'
import { WebSyncEngine } from './lib/sync/sync-engine'
import { BottomNav, type AppView } from './ui/bottom-nav'
import { DiveTransition } from './ui/dive-transition'
import { Wordmark } from './ui/wordmark'

export interface AppProps {
  /** Injectable for tests; production always uses the Dexie-backed implementations. */
  engine?: SyncEngine
  auth?: AuthProvider
}

/** 'unknown' is the first paint, before /api/me answers — distinct from 'signed-out' so the
 * sign-in screen never flashes at an angler who is already signed in. */
type SessionState = 'unknown' | 'signed-out' | { user: User }

/** One instance, not one per render: the effects below key off `auth`, and a fresh provider on
 * every render would re-run them (and /api/me) forever. */
const webAuth = new WebAuthProvider()

// Epic 1-3 shell: sign-in gate, trip lifecycle, capture, journal and free-tier stats. Patterns
// (Epic 4) and Briefing (Epic 5) join the nav when they exist.
export function App({ engine, auth = webAuth }: AppProps = {}) {
  const [view, setView] = useState<AppView>('journal')
  const [session, setSession] = useState<SessionState>('unknown')
  const [signOutPending, setSignOutPending] = useState(isLogoutPending)
  const [showDiveTransition, setShowDiveTransition] = useState(false)
  /** What the other tabs were last told. Announcing only real changes is what stops two tabs
   * from bouncing the same user id off each other forever. */
  const announcedUserId = useRef<string | null>(null)
  /** The entrance runs once per signed-in visit, not every time an API response refreshes it. */
  const enteredUserId = useRef<string | null>(null)

  const applySession = useCallback((user: User | null) => {
    const userId = user?.id ?? null
    // Before the queue is touched: rows are stamped with whoever this is, and a flush only
    // sends rows already stamped for them.
    setActiveUserId(userId)
    setSession(user ? { user } : 'signed-out')
    if (user && enteredUserId.current !== user.id) {
      enteredUserId.current = user.id
      setShowDiveTransition(true)
    } else if (!user) {
      enteredUserId.current = null
      setShowDiveTransition(false)
    }
    const changed = announcedUserId.current !== userId
    announcedUserId.current = userId
    if (changed) publishSessionChange(userId)
  }, [])

  const loadSession = useCallback(async () => {
    // A sign-out this device never got to confirm outranks any cookie still lying around: retry
    // it first, and stay on the sign-in screen until the server agrees the session is gone.
    if (isLogoutPending()) {
      try {
        await auth.signOut()
        clearLogoutPending()
        setSignOutPending(false)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          // The server has no session to revoke — the sign-out is already true.
          clearLogoutPending()
          setSignOutPending(false)
        } else {
          applySession(null)
          return
        }
      }
    }
    try {
      const user = await auth.currentUser()
      applySession(user)
    } catch {
      // Offline or the API is down: an existing session is still valid, and the app is
      // offline-first — keep the angler in rather than locking them out of their own journal.
      setSession((current) => (current === 'unknown' ? 'signed-out' : current))
    }
  }, [applySession, auth])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  // One place decides what a 401 means, wherever it surfaces: the session is gone, sign in.
  // And one place decides what a 409 session_mismatch means: this tab is wrong about who is
  // signed in, so ask the server and believe the answer. Nothing was written either way.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setActiveUserId(null)
      setSession('signed-out')
    })
    setSessionMismatchHandler(async () => {
      try {
        applySession(await auth.currentUser())
      } catch {
        // Couldn't reach /api/me: leave the UI alone. The queue stays put either way — the
        // server just refused the only write that could have gone to the wrong account.
      }
    })
    return () => {
      setUnauthorizedHandler(null)
      setSessionMismatchHandler(null)
    }
  }, [applySession, auth])

  // Another tab signed out, or somebody else signed in there. Rebind the queue immediately —
  // that is the part with consequences — then catch the UI up. A sign-out locks this tab now
  // rather than after a round trip.
  useEffect(
    () =>
      subscribeToSessionChanges((userId) => {
        announcedUserId.current = userId
        setActiveUserId(userId)
        if (userId === null) {
          setSession('signed-out')
          setSignOutPending(isLogoutPending())
          return
        }
        void loadSession()
      }),
    [loadSession],
  )

  // A sign-out the server never confirmed is retried as soon as the device is back online, so
  // the cookie doesn't outlive the angler's decision by a whole session.
  useEffect(() => {
    if (!signOutPending || typeof window === 'undefined') return
    const retry = (): void => {
      void auth
        .signOut()
        .then(() => {
          clearLogoutPending()
          setSignOutPending(false)
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401) {
            clearLogoutPending()
            setSignOutPending(false)
          }
        })
    }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [auth, signOutPending])

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
    //
    // The flag goes up *before* the call: locking the screen while the cookie is still alive is
    // the honest half of a sign-out, not the whole of it, and a tab closed mid-request must
    // still come back knowing it owes the server a revocation.
    markLogoutPending()
    try {
      await auth.signOut()
      clearLogoutPending()
      setSignOutPending(false)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearLogoutPending() // no session left to revoke — done, not pending
        setSignOutPending(false)
      } else {
        setSignOutPending(true) // offline or the API is down: retried on reconnect and on boot
      }
    }
    applySession(null)
  }

  if (session === 'unknown') return <div className="app-boot" aria-hidden="true" />
  if (session === 'signed-out') return <SignIn auth={auth} signOutPending={signOutPending} />

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
      {showDiveTransition && <DiveTransition key={session.user.id} />}
    </main>
  )
}
