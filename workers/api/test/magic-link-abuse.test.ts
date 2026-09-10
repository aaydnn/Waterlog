import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { MAGIC_LINK_PER_EMAIL, MAGIC_LINK_PER_IP } from '../src/lib/rate-limit'
import { ConsoleMailer, getMailer, MailerNotConfiguredError, ResendMailer } from '../src/lib/mailer'

/** Posts to /api/auth/magic-link, swallowing whatever the console mailer prints. */
async function requestLink(
  email: string,
  opts: { ip?: string; env?: Record<string, unknown> } = {},
): Promise<Response> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    return await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.ip ? { 'CF-Connecting-IP': opts.ip } : {}),
        },
        body: JSON.stringify({ email }),
      },
      opts.env ?? env,
    )
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }
}

async function tokenCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM login_tokens').first<{ n: number }>()
  return row!.n
}

describe('magic link rate limiting', () => {
  it('cuts off a burst against one address and mints no token past the limit', async () => {
    // The reported finding: 12 consecutive requests all succeeded and created 12 tokens.
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      statuses.push((await requestLink('burst@example.com', { ip: '203.0.113.10' })).status)
    }

    const allowed = statuses.filter((s) => s === 200).length
    expect(allowed).toBe(MAGIC_LINK_PER_EMAIL.limit)
    expect(statuses.slice(MAGIC_LINK_PER_EMAIL.limit)).toEqual(
      Array(12 - MAGIC_LINK_PER_EMAIL.limit).fill(429),
    )

    // A limited request creates nothing. Of the 5 that got through, only the newest token is
    // still live — minting supersedes an address's older unconsumed links.
    const rows = await env.DB.prepare(
      'SELECT count(*) AS n FROM login_tokens WHERE email = ? AND consumed_at IS NULL',
    )
      .bind('burst@example.com')
      .first<{ n: number }>()
    expect(rows!.n).toBe(1)
    expect(await tokenCount()).toBe(MAGIC_LINK_PER_EMAIL.limit)
  })

  it('answers 429 with a generic body and a Retry-After', async () => {
    for (let i = 0; i < MAGIC_LINK_PER_EMAIL.limit; i++) {
      await requestLink('generic@example.com', { ip: '203.0.113.11' })
    }
    const res = await requestLink('generic@example.com', { ip: '203.0.113.11' })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'too many requests' })
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('counts each address separately', async () => {
    for (let i = 0; i < MAGIC_LINK_PER_EMAIL.limit; i++) {
      await requestLink('first@example.com', { ip: '203.0.113.12' })
    }
    expect((await requestLink('first@example.com', { ip: '203.0.113.12' })).status).toBe(429)
    expect((await requestLink('second@example.com', { ip: '203.0.113.12' })).status).toBe(200)
  })

  it('treats case and whitespace as the same address, not a fresh quota', async () => {
    for (let i = 0; i < MAGIC_LINK_PER_EMAIL.limit; i++) {
      await requestLink('mixed@example.com', { ip: '203.0.113.13' })
    }
    const res = await requestLink('  MiXeD@Example.COM  ', { ip: '203.0.113.13' })
    expect(res.status).toBe(429)
  })

  it('cuts off a sweep across many addresses from one IP', async () => {
    // Distinct address each time, so only the per-IP quota can stop this.
    const statuses: number[] = []
    for (let i = 0; i < MAGIC_LINK_PER_IP.limit + 2; i++) {
      statuses.push((await requestLink(`sweep${i}@example.com`, { ip: '203.0.113.20' })).status)
    }
    expect(statuses.filter((s) => s === 200).length).toBe(MAGIC_LINK_PER_IP.limit)
    expect(statuses.at(-1)).toBe(429)
    expect(await tokenCount()).toBe(MAGIC_LINK_PER_IP.limit)

    // A different source is unaffected.
    expect((await requestLink('elsewhere@example.com', { ip: '198.51.100.7' })).status).toBe(200)
  })

  it('gives requests with no CF-Connecting-IP their own bucket rather than a bypass', async () => {
    const statuses: number[] = []
    for (let i = 0; i < MAGIC_LINK_PER_IP.limit + 1; i++) {
      statuses.push((await requestLink(`anon${i}@example.com`)).status)
    }
    expect(statuses.at(-1)).toBe(429)
    // The 'unknown' bucket is its own: an identified caller still gets a full quota.
    expect((await requestLink('known@example.com', { ip: '198.51.100.9' })).status).toBe(200)
  })

  it('rejects an over-long address before it reaches the DB', async () => {
    const long = `${'a'.repeat(250)}@example.com` // 262 chars
    const res = await requestLink(long)
    expect(res.status).toBe(400)
    expect(await tokenCount()).toBe(0)
  })
})

describe('magic link token hygiene', () => {
  it('minting a new link invalidates that address’s older unconsumed one', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'super@example.com' }),
      },
      env,
    )
    const firstLink = /(http\S+verify\?token=\S+)/.exec(
      logSpy.mock.calls.map((a) => a.join(' ')).join('\n'),
    )?.[1]
    logSpy.mockClear()
    await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'super@example.com' }),
      },
      env,
    )
    const secondLink = /(http\S+verify\?token=\S+)/.exec(
      logSpy.mock.calls.map((a) => a.join(' ')).join('\n'),
    )?.[1]
    logSpy.mockRestore()

    expect(firstLink).toBeTruthy()
    expect(secondLink).toBeTruthy()
    expect((await app.request(firstLink!, {}, env)).status).toBe(401)
    expect((await app.request(secondLink!, {}, env)).status).toBe(302)
  })

  it('sweeps expired tokens on the next mint, so the table cannot grow forever', async () => {
    const now = Date.now()
    await env.DB.prepare(
      'INSERT INTO login_tokens (id, email, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)',
    )
      .bind('dead-token-hash', 'gone@example.com', now - 1000, now - 60 * 60 * 1000)
      .run()
    expect(await tokenCount()).toBe(1)

    await requestLink('fresh@example.com', { ip: '198.51.100.30' })

    const dead = await env.DB.prepare('SELECT count(*) AS n FROM login_tokens WHERE id = ?')
      .bind('dead-token-hash')
      .first<{ n: number }>()
    expect(dead!.n).toBe(0)
    expect(await tokenCount()).toBe(1) // only the fresh one
  })

  it('sweeps closed rate-limit windows', async () => {
    await env.DB.prepare(
      'INSERT INTO rate_limits (bucket, count, window_start, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind('magic-link:ip:stale', 99, Date.now() - 60 * 60 * 1000, Date.now() - 1000)
      .run()

    await requestLink('sweeper@example.com', { ip: '198.51.100.31' })

    const stale = await env.DB.prepare('SELECT count(*) AS n FROM rate_limits WHERE bucket = ?')
      .bind('magic-link:ip:stale')
      .first<{ n: number }>()
    expect(stale!.n).toBe(0)
  })
})

describe('mailer configuration', () => {
  it('uses the console mailer only when explicitly allowed', () => {
    const mailer = getMailer({ ...env, RESEND_API_KEY: undefined, ALLOW_CONSOLE_MAIL: 'true' })
    expect(mailer).toBeInstanceOf(ConsoleMailer)
  })

  it('throws when no key is set and console mail is not allowed', () => {
    expect(() =>
      getMailer({ ...env, RESEND_API_KEY: undefined, ALLOW_CONSOLE_MAIL: undefined }),
    ).toThrow(MailerNotConfiguredError)
  })

  it('uses Resend whenever a key is set, flag or no flag', () => {
    expect(getMailer({ ...env, RESEND_API_KEY: 'k', ALLOW_CONSOLE_MAIL: 'true' })).toBeInstanceOf(
      ResendMailer,
    )
    expect(
      getMailer({ ...env, RESEND_API_KEY: 'k', ALLOW_CONSOLE_MAIL: undefined }),
    ).toBeInstanceOf(ResendMailer)
  })

  it('503s and mints no token when mail is unconfigured — never logs the link', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request(
      '/api/auth/magic-link',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nomail@example.com' }),
      },
      { ...env, RESEND_API_KEY: undefined, ALLOW_CONSOLE_MAIL: undefined },
    )
    const logged = logSpy.mock.calls.map((a) => a.join(' ')).join('\n')
    logSpy.mockRestore()
    errSpy.mockRestore()

    expect(res.status).toBe(503)
    expect(logged).not.toContain('magic-link/verify')
    expect(await tokenCount()).toBe(0)
    // The quota is not spent on a request the server refused to serve.
    const limits = await env.DB.prepare('SELECT count(*) AS n FROM rate_limits').first<{
      n: number
    }>()
    expect(limits!.n).toBe(0)
  })
})
