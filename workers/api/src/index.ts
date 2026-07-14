import { Hono } from 'hono'
import type { AppEnv } from './env'
import { VERSION } from './version'

const app = new Hono<AppEnv>()

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }))

// Protected in T0.3 by the requireAuth middleware.
app.get('/api/me', (c) => c.json({ error: 'not implemented' }, 501))

export default app
