import { Hono } from 'hono'
import type { AppEnv } from './env'
import { requireAuth } from './middleware/require-auth'
import { authRoutes } from './routes/auth'
import { journalRoutes, statsRoutes } from './routes/journal'
import { lureRoutes } from './routes/lures'
import { photoRoutes } from './routes/photos'
import { syncRoutes } from './routes/sync'
import { tripRoutes } from './routes/trips'
import { waterBodyRoutes } from './routes/water-bodies'
import { VERSION } from './version'

const app = new Hono<AppEnv>()

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }))

app.route('/api/auth', authRoutes)
app.route('/api/sync', syncRoutes)
app.route('/api/photos', photoRoutes)
app.route('/api/lures', lureRoutes)
app.route('/api/trips', tripRoutes)
app.route('/api/water-bodies', waterBodyRoutes)
app.route('/api/journal', journalRoutes)
app.route('/api/stats', statsRoutes)

app.get('/api/me', requireAuth, (c) => c.json({ user: c.get('user') }))

export default app
