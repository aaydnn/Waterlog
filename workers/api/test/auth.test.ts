import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { generateToken, sha256Hex } from '../src/lib/crypto'
import { validateSession, SESSION_TTL_MS } from '../src/lib/sessions'

function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? ''
  const match = /session=([^;]+)/.exec(header)
  if (!match?.[1]) throw new Error(`no session cookie in: ${header}`)
  return match[1]
}

/** Runs the magic-link flow and returns the session cookie token. */
async function signInWithMagicLink(email: string): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const requestRes = await app.request(
    '/api/auth/magic-link',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    },
    env,
  )
  expect(requestRes.status).toBe(200)

  const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n')
  logSpy.mockRestore()
  const link = /(http\S+\/api\/auth\/magic-link\/verify\?token=\S+)/.exec(logged)?.[1]
  if (!link) throw new Error('magic link was not logged to console')

  const verifyRes = await app.request(link, {}, env)
  expect(verifyRes.status).toBe(302)
  return sessionCookie(verifyRes)
}

describe('GET /api/me', () => {
  it('401s without a cookie', async () => {
    const res = await app.request('/api/me', {}, env)
    expect(res.status).toBe(401)
  })

  it('401s with a bogus session token', async () => {
    const res = await app.request(
      '/api/me',
      { headers: { cookie: `session=${generateToken()}` } },
      env,
    )
    expect(res.status).toBe(401)
  })
})

describe('magic link flow', () => {
  it('signs in end-to-end via the console-logged link', async () => {
    const token = await signInWithMagicLink('angler@example.com')
    const me = await app.request('/api/me', { headers: { cookie: `session=${token}` } }, env)
    expect(me.status).toBe(200)
    const body = (await me.json()) as { user: { email: string } }
    expect(body.user.email).toBe('angler@example.com')
  })

  it('sets an HttpOnly; Secure; SameSite=Lax session cookie', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'cookie@example.com' }),
      },
      env,
    )
    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    logSpy.mockRestore()
    const link = /(http\S+verify\?token=\S+)/.exec(logged)?.[1]
    const res = await app.request(link!, {}, env)

    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
  })

  it('rejects a replayed (already consumed) token with 401', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'replay@example.com' }),
      },
      env,
    )
    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    logSpy.mockRestore()
    const link = /(http\S+verify\?token=\S+)/.exec(logged)?.[1]

    const first = await app.request(link!, {}, env)
    expect(first.status).toBe(302)
    const replay = await app.request(link!, {}, env)
    expect(replay.status).toBe(401)
  })

  it('rejects an expired token with 401', async () => {
    const raw = generateToken()
    const now = Date.now()
    await env.DB.prepare(
      'INSERT INTO login_tokens (id, email, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)',
    )
      .bind(await sha256Hex(raw), 'late@example.com', now - 1000, now - 11 * 60 * 1000)
      .run()

    const res = await app.request(`/api/auth/magic-link/verify?token=${raw}`, {}, env)
    expect(res.status).toBe(401)
  })

  it('does not leak whether an address has an account', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'never-seen@example.com' }),
      },
      env,
    )
    logSpy.mockRestore()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('google oauth flow', () => {
  const googleEnv = { ...env, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' }

  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
  })

  function mockTokenExchange(email: string) {
    const payload = btoa(JSON.stringify({ email, email_verified: true, sub: '123' }))
    fetchMock
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, JSON.stringify({ id_token: `h.${payload}.s` }), {
        headers: { 'content-type': 'application/json' },
      })
  }

  async function signInWithGoogle(email: string): Promise<string> {
    const start = await app.request('/api/auth/google', {}, googleEnv)
    expect(start.status).toBe(302)
    expect(start.headers.get('location')).toContain('accounts.google.com')
    const stateCookie = /oauth_state=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')?.[1]
    expect(stateCookie).toBeTruthy()

    mockTokenExchange(email)
    const callback = await app.request(
      `/api/auth/google/callback?code=fake-code&state=${stateCookie}`,
      { headers: { cookie: `oauth_state=${stateCookie}` } },
      googleEnv,
    )
    expect(callback.status).toBe(302)
    return sessionCookie(callback)
  }

  it('creates a user and issues a session', async () => {
    const token = await signInWithGoogle('googler@example.com')
    const me = await app.request('/api/me', { headers: { cookie: `session=${token}` } }, env)
    expect(me.status).toBe(200)
    const body = (await me.json()) as { user: { email: string } }
    expect(body.user.email).toBe('googler@example.com')
  })

  it('links to the existing user with the same email', async () => {
    const magicToken = await signInWithMagicLink('shared@example.com')
    const meMagic = await app.request(
      '/api/me',
      { headers: { cookie: `session=${magicToken}` } },
      env,
    )
    const magicUser = ((await meMagic.json()) as { user: { id: string } }).user

    const googleToken = await signInWithGoogle('shared@example.com')
    const meGoogle = await app.request(
      '/api/me',
      { headers: { cookie: `session=${googleToken}` } },
      env,
    )
    const googleUser = ((await meGoogle.json()) as { user: { id: string } }).user

    expect(googleUser.id).toBe(magicUser.id)
  })

  it('rejects a state mismatch', async () => {
    const res = await app.request(
      '/api/auth/google/callback?code=fake-code&state=evil',
      { headers: { cookie: 'oauth_state=good' } },
      googleEnv,
    )
    expect(res.status).toBe(401)
  })
})

describe('sessions', () => {
  it('logout destroys the session', async () => {
    const token = await signInWithMagicLink('bye@example.com')
    const out = await app.request(
      '/api/auth/logout',
      { method: 'POST', headers: { cookie: `session=${token}` } },
      env,
    )
    expect(out.status).toBe(200)
    const me = await app.request('/api/me', { headers: { cookie: `session=${token}` } }, env)
    expect(me.status).toBe(401)
  })

  it('slides the expiry when under half the TTL remains', async () => {
    const raw = generateToken()
    const id = await sha256Hex(raw)
    const now = Date.now()
    const soon = now + SESSION_TTL_MS / 4 // well inside the renewal window
    await env.DB.prepare(
      "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES ('u1', 's@example.com', 'imperial', 'free', ?, ?)",
    )
      .bind(now, now)
      .run()
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'u1', ?, ?)",
    )
      .bind(id, soon, now)
      .run()

    const session = await validateSession(env.DB, raw)
    expect(session).not.toBeNull()
    expect(session!.expires_at).toBeGreaterThan(soon)

    const stored = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ?')
      .bind(id)
      .first<{ expires_at: number }>()
    expect(stored!.expires_at).toBe(session!.expires_at)
  })

  it('deletes an expired session and 401s', async () => {
    const raw = generateToken()
    const now = Date.now()
    await env.DB.prepare(
      "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES ('u2', 'x@example.com', 'imperial', 'free', ?, ?)",
    )
      .bind(now, now)
      .run()
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'u2', ?, ?)",
    )
      .bind(await sha256Hex(raw), now - 1000, now - SESSION_TTL_MS)
      .run()

    const me = await app.request('/api/me', { headers: { cookie: `session=${raw}` } }, env)
    expect(me.status).toBe(401)
    const left = await env.DB.prepare('SELECT count(*) AS n FROM sessions').first<{ n: number }>()
    expect(left!.n).toBe(0)
  })
})
