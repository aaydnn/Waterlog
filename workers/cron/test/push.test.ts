import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { ulid } from 'ulid'
import { announceFirstPattern, vapidKeysFrom } from '../src/lib/notify'
import { base64UrlDecode, base64UrlEncode, encryptPayload, sendPush, signVapidToken } from '../src/lib/web-push'

const NOW = Date.UTC(2026, 8, 15, 8)

/** A throwaway VAPID keypair, generated here so no real key is ever committed. */
async function generateVapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  return {
    publicKey: base64UrlEncode(raw),
    privateKey: jwk.d!,
    subject: 'mailto:hello@waterlog.app',
    verifyKey: pair.publicKey,
  }
}

/** A stand-in browser subscription: a P-256 keypair plus a 16-byte auth secret. */
async function generateSubscription(endpoint: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  return {
    endpoint,
    p256dh: base64UrlEncode(raw),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  }
}

async function seedUserWithSubscription(email: string, endpoint: string): Promise<string> {
  const userId = ulid()
  await env.DB.prepare(
    "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES (?, ?, 'imperial', 'pro', ?, ?)",
  )
    .bind(userId, email, NOW, NOW)
    .run()
  const subscription = await generateSubscription(endpoint)
  await env.DB.prepare(
    'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(ulid(), userId, subscription.endpoint, subscription.p256dh, subscription.auth, NOW)
    .run()
  return userId
}

describe('base64url', () => {
  it('round-trips bytes of every padding length', () => {
    for (const length of [1, 2, 3, 16, 32, 65]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length))
      expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes])
    }
  })

  it('emits no character that needs escaping in a header or a URL', () => {
    const encoded = base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)))
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('the VAPID token', () => {
  it('is a JWT the push service can verify with the public key we advertise', async () => {
    const keys = await generateVapidKeys()
    const token = await signVapidToken(keys, 'https://push.example.com', NOW)
    const [header, payload, signature] = token.split('.')

    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(header!)))).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    })
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload!)))
    expect(claims.aud).toBe('https://push.example.com')
    expect(claims.sub).toBe('mailto:hello@waterlog.app')
    expect(claims.exp).toBe(Math.floor(NOW / 1000) + 12 * 60 * 60)

    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.verifyKey,
      base64UrlDecode(signature!),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(verified).toBe(true)
  })
})

describe('aes128gcm encryption', () => {
  it('lays the body out as salt, record size, key length, key, ciphertext', async () => {
    const subscription = await generateSubscription('https://push.example.com/abc')
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const body = await encryptPayload(subscription, new TextEncoder().encode('hello'), salt)

    expect([...body.slice(0, 16)]).toEqual([...salt])
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096)
    expect(body[20]).toBe(65)
    // 21-byte header + 65-byte ephemeral key + ciphertext (plaintext + delimiter + 16-byte tag).
    expect(body.length).toBe(21 + 65 + 'hello'.length + 1 + 16)
  })

  it('produces a different body every time, because the ephemeral key is ephemeral', async () => {
    const subscription = await generateSubscription('https://push.example.com/abc')
    const plaintext = new TextEncoder().encode('hello')
    const first = await encryptPayload(subscription, plaintext)
    const second = await encryptPayload(subscription, plaintext)
    expect(base64UrlEncode(first)).not.toBe(base64UrlEncode(second))
  })
})

describe('sending', () => {
  it('addresses the push service with the headers RFC 8292 requires', async () => {
    const keys = await generateVapidKeys()
    const subscription = await generateSubscription('https://push.example.com/endpoint-1')
    const calls: { url: string; init: RequestInit }[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return new Response(null, { status: 201 })
    })
    try {
      const result = await sendPush(keys, subscription, { title: 'hi' }, NOW)
      expect(result).toEqual({ status: 201, expired: false })

      const headers = calls[0]!.init.headers as Record<string, string>
      expect(calls[0]!.url).toBe(subscription.endpoint)
      expect(headers['Content-Encoding']).toBe('aes128gcm')
      expect(headers.TTL).toBe(String(24 * 60 * 60))
      // The audience is the service's origin, not the full endpoint.
      expect(headers.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`))
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it.each([404, 410])('reports a %d as a subscription that is gone for good', async (status) => {
    const keys = await generateVapidKeys()
    const subscription = await generateSubscription('https://push.example.com/dead')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }))
    try {
      expect((await sendPush(keys, subscription, {}, NOW)).expired).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('the first-pattern announcement', () => {
  const configured = { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:hello@waterlog.app' }

  async function envWithKeys() {
    const keys = await generateVapidKeys()
    return { ...env, ...configured, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }
  }

  it('sends once and never again, however many times it is called', async () => {
    const userId = await seedUserWithSubscription('first@example.com', 'https://push.example.com/first')
    const withKeys = await envWithKeys()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }))
    try {
      expect(await announceFirstPattern(withKeys, userId, NOW)).toBe(true)
      expect(await announceFirstPattern(withKeys, userId, NOW + 1000)).toBe(false)
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      const user = await env.DB.prepare('SELECT first_pattern_notified_at FROM users WHERE id = ?')
        .bind(userId)
        .first<{ first_pattern_notified_at: number }>()
      expect(user!.first_pattern_notified_at).toBe(NOW)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('deletes a subscription the push service says is revoked', async () => {
    const userId = await seedUserWithSubscription('revoked@example.com', 'https://push.example.com/revoked')
    const withKeys = await envWithKeys()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 410 }))
    try {
      await announceFirstPattern(withKeys, userId, NOW)
      const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?')
        .bind(userId)
        .first<{ n: number }>()
      expect(left!.n).toBe(0)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps the announcement unspent when the angler has no subscription yet', async () => {
    const userId = ulid()
    await env.DB.prepare(
      "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES (?, 'nopush@example.com', 'imperial', 'pro', ?, ?)",
    )
      .bind(userId, NOW, NOW)
      .run()

    expect(await announceFirstPattern(await envWithKeys(), userId, NOW)).toBe(false)
    const user = await env.DB.prepare('SELECT first_pattern_notified_at FROM users WHERE id = ?')
      .bind(userId)
      .first<{ first_pattern_notified_at: number | null }>()
    // Not spent: turning notifications on tomorrow should still get them the news.
    expect(user!.first_pattern_notified_at).toBeNull()
  })

  it('skips silently, and spends nothing, when no VAPID keys are configured', async () => {
    const userId = await seedUserWithSubscription('nokeys@example.com', 'https://push.example.com/nokeys')
    expect(vapidKeysFrom(env)).toBeNull()
    expect(await announceFirstPattern(env, userId, NOW)).toBe(false)

    const user = await env.DB.prepare('SELECT first_pattern_notified_at FROM users WHERE id = ?')
      .bind(userId)
      .first<{ first_pattern_notified_at: number | null }>()
    expect(user!.first_pattern_notified_at).toBeNull()
  })

  it('carries on to the next browser when one send throws', async () => {
    const userId = await seedUserWithSubscription('two-devices@example.com', 'https://push.example.com/device-a')
    const second = await generateSubscription('https://push.example.com/device-b')
    await env.DB.prepare(
      'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(ulid(), userId, second.endpoint, second.p256dh, second.auth, NOW + 1)
      .run()

    const withKeys = await envWithKeys()
    let call = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call += 1
      if (call === 1) throw new Error('network down')
      return new Response(null, { status: 201 })
    })
    try {
      expect(await announceFirstPattern(withKeys, userId, NOW)).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
