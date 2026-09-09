// @vitest-environment jsdom
import type { User } from '@waterlog/schema'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './app'
import { setUnauthorizedHandler } from './lib/api-client'
import { getActiveUserId } from './lib/auth/active-user'
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

/** Every view the shell renders reaches for the API; nothing here is testing those. */
function mockQuietApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ entries: [], next_cursor: null }) })),
  )
}

afterEach(() => {
  setUnauthorizedHandler(null)
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
