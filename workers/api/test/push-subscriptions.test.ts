import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { generateToken, sha256Hex } from '../src/lib/crypto'
import { SESSION_TTL_MS } from '../src/lib/sessions'

async function createUser(email: string): Promise<{ userId: string; cookie: string }> {
  const userId = crypto.randomUUID()
  const now = Date.now()
  await env.DB.prepare(
    "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES (?, ?, 'imperial', 'pro', ?, ?)",
  )
    .bind(userId, email, now, now)
    .run()
  const raw = generateToken()
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(raw), userId, now + SESSION_TTL_MS, now)
    .run()
  return { userId, cookie: `session=${raw}` }
}

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  p256dh: 'BExampleSubscriberPublicKeyBase64UrlEncoded',
  auth: 'ExampleAuthSecret',
}

function subscribe(cookie: string, body: unknown) {
  return app.request(
    '/api/push/subscriptions',
    { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) },
    env,
  )
}

function rowsFor(userId: string) {
  return env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .bind(userId)
    .all<{ endpoint: string; p256dh: string; auth: string }>()
}

describe('POST /api/push/subscriptions', () => {
  it('401s without a session', async () => {
    const res = await app.request(
      '/api/push/subscriptions',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('registers a browser', async () => {
    const { userId, cookie } = await createUser('subscribe@example.com')
    expect((await subscribe(cookie, subscription)).status).toBe(201)
    const { results } = await rowsFor(userId)
    expect(results).toHaveLength(1)
    expect(results[0]!.endpoint).toBe(subscription.endpoint)
  })

  it('does not accumulate rows when the same browser re-registers', async () => {
    const { userId, cookie } = await createUser('resubscribe@example.com')
    await subscribe(cookie, subscription)
    await subscribe(cookie, { ...subscription, p256dh: 'BRotatedKey', auth: 'RotatedSecret' })

    const { results } = await rowsFor(userId)
    expect(results).toHaveLength(1)
    // The keys rotate with the endpoint, so the row stays current rather than stale.
    expect(results[0]).toMatchObject({ p256dh: 'BRotatedKey', auth: 'RotatedSecret' })
  })

  it('re-points an endpoint at whoever signed in on that browser last', async () => {
    const first = await createUser('device-first@example.com')
    const second = await createUser('device-second@example.com')
    await subscribe(first.cookie, subscription)
    await subscribe(second.cookie, subscription)

    expect((await rowsFor(first.userId)).results).toHaveLength(0)
    expect((await rowsFor(second.userId)).results).toHaveLength(1)
  })

  it('400s on a body that is not a subscription', async () => {
    const { cookie } = await createUser('bad-subscribe@example.com')
    expect((await subscribe(cookie, { endpoint: 'not-a-url' })).status).toBe(400)
    expect((await subscribe(cookie, null)).status).toBe(400)
  })
})

describe('DELETE /api/push/subscriptions', () => {
  function unsubscribe(cookie: string, body: unknown) {
    return app.request(
      '/api/push/subscriptions',
      { method: 'DELETE', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) },
      env,
    )
  }

  it('removes the browser that asks', async () => {
    const { userId, cookie } = await createUser('unsubscribe@example.com')
    await subscribe(cookie, subscription)
    expect((await unsubscribe(cookie, { endpoint: subscription.endpoint })).status).toBe(200)
    expect((await rowsFor(userId)).results).toHaveLength(0)
  })

  it("will not remove another angler's subscription", async () => {
    const owner = await createUser('sub-owner@example.com')
    const attacker = await createUser('sub-attacker@example.com')
    await subscribe(owner.cookie, subscription)

    await unsubscribe(attacker.cookie, { endpoint: subscription.endpoint })
    expect((await rowsFor(owner.userId)).results).toHaveLength(1)
  })
})
