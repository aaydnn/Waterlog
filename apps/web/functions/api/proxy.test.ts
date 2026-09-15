import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequest } from './[[path]]'

const API_ORIGIN = 'https://api.example.test'

/** Captures the outgoing subrequest and returns a benign response. */
function stubFetch(response = new Response('{}', { status: 200 })) {
  const spy = vi.fn(async (_input: Request, _init?: RequestInit) => response)
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('/api/* Pages Function proxy', () => {
  it('forwards the path and query string to the API origin', async () => {
    const spy = stubFetch()
    await onRequest({
      request: new Request('https://app.example.test/api/trips/abc/end?dry=1', { method: 'PATCH', body: '{}' }),
      env: { API_ORIGIN },
    })

    const sent = spy.mock.calls[0]![0]
    expect(sent.url).toBe(`${API_ORIGIN}/api/trips/abc/end?dry=1`)
    expect(sent.method).toBe('PATCH')
  })

  it('does not follow redirects, so the browser sees the auth 302 itself', async () => {
    // Following them here would return Google's page body to fetch() instead of redirecting
    // the user, and the OAuth round trip would never complete.
    const spy = stubFetch()
    await onRequest({
      request: new Request('https://app.example.test/api/auth/google'),
      env: { API_ORIGIN },
    })

    expect(spy.mock.calls[0]![1]?.redirect).toBe('manual')
  })

  it('passes the response back untouched, including Set-Cookie', async () => {
    // The cookie is host-only, so proxying is what scopes the session to the app's own origin.
    const upstream = new Response(null, {
      status: 302,
      headers: { location: 'https://app.example.test/', 'set-cookie': 'session=tok; HttpOnly; Path=/' },
    })
    stubFetch(upstream)

    const res = await onRequest({
      request: new Request('https://app.example.test/api/auth/magic-link/verify?token=t'),
      env: { API_ORIGIN },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toContain('session=tok')
  })

  it('falls back to the deployed API when no origin is configured', async () => {
    const spy = stubFetch()
    await onRequest({ request: new Request('https://app.example.test/api/health'), env: {} })

    const sent = spy.mock.calls[0]![0]
    expect(new URL(sent.url).pathname).toBe('/api/health')
    expect(new URL(sent.url).origin).toMatch(/^https:\/\//)
  })

  it('forwards the header naming the account a write is for', async () => {
    // The server compares X-Waterlog-User to the session cookie and 409s on a mismatch; a
    // proxy that dropped it would turn that check into a no-op.
    const spy = stubFetch()
    await onRequest({
      request: new Request('https://app.example.test/api/sync', {
        method: 'POST',
        headers: { 'X-Waterlog-User': 'usr_a', 'content-type': 'application/json' },
        body: '{}',
      }),
      env: { API_ORIGIN },
    })

    expect(spy.mock.calls[0]![0].headers.get('x-waterlog-user')).toBe('usr_a')
  })
})
