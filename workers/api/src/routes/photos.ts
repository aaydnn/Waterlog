import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { newId } from '../lib/ids'
import { requireAuth } from '../middleware/require-auth'

// Client-side capture resizes to a 1600px max edge (packet §10) before upload; this cap is a
// defensive ceiling against abuse, not the expected size.
const MAX_BYTES = 10 * 1024 * 1024

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export const photoRoutes = new Hono<AppEnv>()

// Worker-proxied upload (ADR-0005): the client PUTs raw image bytes here instead of to a
// presigned R2 URL. Keys are scoped under the uploading user so nobody can read or overwrite
// another user's photo by guessing a key.
photoRoutes.post('/', requireAuth, async (c) => {
  const contentType = c.req.header('content-type') ?? ''
  const ext = ALLOWED_TYPES[contentType]
  if (!ext) return c.json({ error: 'unsupported content-type' }, 415)

  const contentLength = Number(c.req.header('content-length') ?? '0')
  if (!contentLength || contentLength > MAX_BYTES) {
    return c.json({ error: 'missing content-length or photo too large' }, 413)
  }

  const user = c.get('user')
  const key = `photos/${user.id}/${newId()}.${ext}`
  await c.env.PHOTOS.put(key, await c.req.arrayBuffer(), { httpMetadata: { contentType } })

  return c.json({ photo_key: key }, 201)
})

// The journal renders these. Keys are user-scoped by construction (ADR-0005), so serving one
// is a prefix check away — never a lookup the client can steer.
photoRoutes.get('/:key{.+}', requireAuth, async (c) => {
  // Accepts the stored key as-is (photos/<user>/<file>) so the client can just interpolate
  // photo_key, and the bare form too.
  const raw = c.req.param('key')
  const key = raw.startsWith('photos/') ? raw : `photos/${raw}`
  const user = c.get('user')
  if (!key.startsWith(`photos/${user.id}/`)) return c.json({ error: 'not found' }, 404)

  const object = await c.env.PHOTOS.get(key)
  if (!object) return c.json({ error: 'not found' }, 404)

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=31536000, immutable',
      etag: object.httpEtag,
    },
  })
})
