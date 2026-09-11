// @vitest-environment jsdom
import type { User } from '@waterlog/schema'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './app'
import { ApiError, setSessionMismatchHandler, setUnauthorizedHandler } from './lib/api-client'
import { getActiveUserId } from './lib/auth/active-user'
import { forgetDeviceAccounts } from './lib/auth/device-accounts'
import { clearLogoutPending, isLogoutPending, markLogoutPending } from './lib/auth/pending-revocation'
import { closeSessionChannel } from './lib/auth/session-channel'
import type { AuthProvider, SignInResult } from './lib/auth/auth-provider'
import type { SyncEngine } from './lib/sync/sync-engine'

const user: User = {
  id: 'u1',
  email: 'angler@example.com',
  display_name: null,
  home_lat: null,
  home_lng: null,
  units: 'imperial',
  tier: 'free',
  stripe_customer_id: null,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
}

function fakeAuth(currentUser: () => Promise<User | null>): AuthProvider {
  return {
    currentUser: vi.fn(currentUser),
    signIn: vi.fn<() => Promise<SignInResult>>().mockResolvedValue({ kind: 'redirecting' }),
    signOut: vi.fn(),
  }
}

const idleEngine: SyncEngine = {
  enqueueTrip: vi.fn(),
  enqueueCatch: vi.fn(),
  endTrip: vi.fn(),
  flush: vi.fn().mockResolvedValue({ pushed: 0, failed: 0 }),
} as unknown as SyncEngine

/** Every view the shell renders reaches for the API; nothing here is testing those. Shapes are
 * per-endpoint on purpose — one catch-all body would hand the stats view a journal page and
 * blow up inside it, which says nothing about the shell. */
function mockQuietApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/api/stats')
        ? {
            totals: { catches: 0, trips: 0, hours_on_water: 0, skunked_trips: 0, species: 0, waters: 0 },
            by_species: [],
            by_month: [],
            by_water: [],
          }
        : url.includes('/api/water-bodies')
          ? { water_bodies: [] }
          : { entries: [], next_cursor: null }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

afterEach(() => {
  setUnauthorizedHandler(null)
  setSessionMismatchHandler(null)
  clearLogoutPending()
  forgetDeviceAccounts()
  closeSessionChannel()
  vi.unstubAllGlobals()
})

describe('App session gate', () => {
  it('shows the sign-in screen when nobody is signed in', async () => {
    mockQuietApi()
    render(<App engine={idleEngine} auth={fakeAuth(async () => null)} />)

    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument()
  })

  it('shows the app once there is a session', async () => {
    mockQuietApi()
    render(<App engine={idleEngine} auth={fakeAuth(async () => user)} />)

    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument()
    expect(screen.getByTestId('dive-transition')).toBeInTheDocument()
  })

  it('never flashes sign-in at an angler who turns out to be signed in', async () => {
    mockQuietApi()
    let resolve: ((u: User) => void) | undefined
    const pending = new Promise<User>((r) => {
      resolve = r
    })
    render(<App engine={idleEngine} auth={fakeAuth(() => pending)} />)

    // While /api/me is still in flight, neither screen is committed to.
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument()

    resolve!(user)
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument()
  })

  it('returns to sign-in when any request reports the session is gone', async () => {
    mockQuietApi()
    render(<App engine={idleEngine} auth={fakeAuth(async () => user)} />)
    await screen.findByRole('navigation', { name: 'Main' })

    // What the api-client does on any 401, from any caller.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })),
    )
    const { apiClient } = await import('./lib/api-client')
    await apiClient.stats().catch(() => undefined)

    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
  })

  it('signs out to the sign-in screen, without clearing what is still queued', async () => {
    mockQuietApi()
    const auth = fakeAuth(async () => user)
    const testUser = userEvent.setup()
    render(<App engine={idleEngine} auth={auth} />)
    await screen.findByRole('navigation', { name: 'Main' })

    await testUser.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    expect(auth.signOut).toHaveBeenCalledTimes(1)
    expect(getActiveUserId()).toBeNull()
  })

  it('switches between Journal and Stats', async () => {
    mockQuietApi()
    const testUser = userEvent.setup()
    render(<App engine={idleEngine} auth={fakeAuth(async () => user)} />)

    await screen.findByRole('navigation', { name: 'Main' })
    expect(screen.getByRole('region', { name: 'Catch journal' })).toBeInTheDocument()

    await testUser.click(screen.getByRole('button', { name: 'Stats' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Catch journal' })).not.toBeInTheDocument())
  })
})

describe('App sign-out that the server never confirmed (finding 8)', () => {
  it('locks the device, remembers the revocation it owes, and says so', async () => {
    mockQuietApi()
    const auth = fakeAuth(async () => user)
    auth.signOut = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('offline'))
    const testUser = userEvent.setup()
    render(<App engine={idleEngine} auth={auth} />)
    await screen.findByRole('navigation', { name: 'Main' })

    await testUser.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    expect(getActiveUserId()).toBeNull()
    expect(isLogoutPending()).toBe(true)
    expect(screen.getByText(/finish signing you out/i)).toBeInTheDocument()
  })

  it('will not restore a cookie session on the next boot while the revocation is still owed', async () => {
    mockQuietApi()
    markLogoutPending()
    // The cookie is still valid — that is exactly the problem — but the sign-out was real.
    const auth = fakeAuth(async () => user)
    auth.signOut = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('offline'))
    render(<App engine={idleEngine} auth={auth} />)

    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    expect(auth.signOut).toHaveBeenCalledTimes(1)
    expect(auth.currentUser).not.toHaveBeenCalled()
    expect(isLogoutPending()).toBe(true)
  })

  it('retries the revocation on boot and, once it lands, is an ordinary sign-in again', async () => {
    mockQuietApi()
    markLogoutPending()
    const auth = fakeAuth(async () => null)
    render(<App engine={idleEngine} auth={auth} />)

    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    await waitFor(() => expect(isLogoutPending()).toBe(false))
    expect(screen.queryByText(/finish signing you out/i)).not.toBeInTheDocument()
  })

  it('treats "no session to revoke" as a finished sign-out, not a failure', async () => {
    mockQuietApi()
    markLogoutPending()
    const auth = fakeAuth(async () => null)
    auth.signOut = vi.fn<() => Promise<void>>().mockRejectedValue(new ApiError(401, 'unauthorized'))
    render(<App engine={idleEngine} auth={auth} />)

    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    await waitFor(() => expect(isLogoutPending()).toBe(false))
  })
})

describe('App session changes elsewhere (finding 1)', () => {
  it('re-resolves who is signed in when a write is rejected as somebody else’s', async () => {
    mockQuietApi()
    const other: User = { ...user, id: 'u2', email: 'other@example.com' }
    const auth = fakeAuth(async () => user)
    render(<App engine={idleEngine} auth={auth} />)
    await screen.findByRole('navigation', { name: 'Main' })
    expect(getActiveUserId()).toBe('u1')

    // What the api-client does on a 409 session_mismatch, from any caller.
    auth.currentUser = vi.fn<() => Promise<User | null>>().mockResolvedValue(other)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'session_mismatch' }) })),
    )
    const { apiClient } = await import('./lib/api-client')
    await apiClient.sync({ trips: [], catches: [] }, 'u1').catch(() => undefined)

    // The queue is rebound to whoever is really here before anything else is attempted.
    await waitFor(() => expect(getActiveUserId()).toBe('u2'))
  })

  it('locks this tab when another tab signs out', async () => {
    mockQuietApi()
    render(<App engine={idleEngine} auth={fakeAuth(async () => user)} />)
    await screen.findByRole('navigation', { name: 'Main' })

    const otherTab = new BroadcastChannel('waterlog-session')
    otherTab.postMessage({ user_id: null })

    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    expect(getActiveUserId()).toBeNull()
    otherTab.close()
  })

  it('rebinds the queue when another tab signs in as somebody else', async () => {
    mockQuietApi()
    const other: User = { ...user, id: 'u2', email: 'other@example.com' }
    const auth = fakeAuth(async () => user)
    render(<App engine={idleEngine} auth={auth} />)
    await screen.findByRole('navigation', { name: 'Main' })

    auth.currentUser = vi.fn<() => Promise<User | null>>().mockResolvedValue(other)
    const otherTab = new BroadcastChannel('waterlog-session')
    otherTab.postMessage({ user_id: 'u2' })

    await waitFor(() => expect(getActiveUserId()).toBe('u2'))
    otherTab.close()
  })
})
