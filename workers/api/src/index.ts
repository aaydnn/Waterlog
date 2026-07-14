import { Hono } from 'hono'
import type { AppEnv } from './env'
import { requireAuth } from './middleware/require-auth'
import { authRoutes } from './routes/auth'
import { VERSION } from './version'

const app = new Hono<AppEnv>()

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }))

app.route('/api/auth', authRoutes)

app.get('/api/me', requireAuth, (c) => c.json({ user: c.get('user') }))

export default app
