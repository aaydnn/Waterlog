import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnsupportedAuthMethodError, WebAuthProvider } from './auth-provider'

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return handler(String(input), init)
    }),
  )
  return calls
}

const user = {
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

afterEach(() => vi.unstubAllGlobals())

describe('WebAuthProvider', () => {
  it('sends the browser to the API for Google, on this origin so the cookie sticks', async () => {
    const redirects: string[] = []
    const result = await new WebAuthProvider((url) => redirects.push(url)).signIn('google')

    expect(result).toEqual({ kind: 'redirecting' })
    expect(redirects).toEqual(['/api/auth/google'])
  })

  it('requests a magic link and reports where it went', async () => {
    const calls = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    const result = await new WebAuthProvider().signIn('magic-link', { email: ' angler@example.com ' })

    expect(result).toEqual({ kind: 'email-sent', email: 'angler@example.com' })
    expect(calls[0]!.url).toContain('/api/auth/magic-link')
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ email: 'angler@example.com' })
  })

  it('refuses a magic link with no address rather than posting an empty one', async () => {
    const calls = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    await expect(new WebAuthProvider().signIn('magic-link', { email: '  ' })).rejects.toThrow(/requires an email/)
    expect(calls).toHaveLength(0)
  })

  it('names Apple as unavailable on web rather than failing obscurely', async () => {
    await expect(new WebAuthProvider().signIn('apple')).rejects.toBeInstanceOf(UnsupportedAuthMethodError)
  })

  it('returns the signed-in user', async () => {
    mockFetch(() => ({ ok: true, status: 200, json: async () => ({ user }) }))
    await expect(new WebAuthProvider().currentUser()).resolves.toMatchObject({ email: 'angler@example.com' })
  })

  it('reads a 401 as "nobody is signed in", not as a failure', async () => {
    mockFetch(() => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }))
    await expect(new WebAuthProvider().currentUser()).resolves.toBeNull()
  })

  it('rethrows anything else, so a flaky network never reads as signed out', async () => {
    mockFetch(() => {
      throw new Error('offline')
    })
    await expect(new WebAuthProvider().currentUser()).rejects.toThrow('offline')

    mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }))
    await expect(new WebAuthProvider().currentUser()).rejects.toThrow(/500/)
  })
})
