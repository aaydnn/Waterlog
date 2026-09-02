import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { generateToken, sha256Hex } from '../src/lib/crypto'
import { SESSION_TTL_MS } from '../src/lib/sessions'

async function createUserAndSession(email: string): Promise<{ userId: string; cookie: string }> {
  const userId = crypto.randomUUID()
  const now = Date.now()
  await env.DB.prepare(
    "INSERT INTO users (id, email, units, tier, created_at, updated_at) VALUES (?, ?, 'imperial', 'free', ?, ?)",
  )
    .bind(userId, email, now, now)
    .run()

  const raw = generateToken()
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(raw), userId, now + SESSION_TTL_MS, now)
    .run()

  return { userId, cookie: `session=${raw}` }
}

function upload(cookie: string, body: Uint8Array, contentType: string) {
  const headers: Record<string, string> = { 'content-length': String(body.byteLength) }
  if (cookie) headers.cookie = cookie
  if (contentType) headers['content-type'] = contentType
  return app.request('/api/photos', { method: 'POST', headers, body }, env)
}

const fakeJpeg = new TextEncoder().encode('not-really-a-jpeg-but-bytes-are-bytes')

describe('POST /api/photos', () => {
  it('401s without a session', async () => {
    const res = await upload('', fakeJpeg, 'image/jpeg')
    expect(res.status).toBe(401)
  })

  it('uploads a jpeg and returns a photo_key scoped under the user', async () => {
    const { userId, cookie } = await createUserAndSession('photog@example.com')
    const res = await upload(cookie, fakeJpeg, 'image/jpeg')
    expect(res.status).toBe(201)

    const body = (await res.json()) as { photo_key: string }
    expect(body.photo_key).toMatch(new RegExp(`^photos/${userId}/[0-9A-Z]+\\.jpg$`))

    const stored = await env.PHOTOS.get(body.photo_key)
    expect(stored).not.toBeNull()
    expect(await stored!.text()).toBe('not-really-a-jpeg-but-bytes-are-bytes')
    expect(stored!.httpMetadata?.contentType).toBe('image/jpeg')
  })

  it('rejects an unsupported content-type', async () => {
    const { cookie } = await createUserAndSession('badtype@example.com')
    const res = await upload(cookie, fakeJpeg, 'application/pdf')
    expect(res.status).toBe(415)
  })

  it('rejects a payload over the size cap', async () => {
    const { cookie } = await createUserAndSession('toobig@example.com')
    const res = await app.request(
      '/api/photos',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'image/jpeg',
          'content-length': String(11 * 1024 * 1024),
        },
        body: fakeJpeg,
      },
      env,
    )
    expect(res.status).toBe(413)
  })
})
