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
