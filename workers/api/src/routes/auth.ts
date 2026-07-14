import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { generateToken } from '../lib/crypto'
import { exchangeGoogleCode, googleAuthorizeUrl } from '../lib/google'
import { createLoginToken, consumeLoginToken } from '../lib/magic-link'
import { getMailer } from '../lib/mailer'
import { clearSessionCookie, readSessionCookie, setSessionCookie } from '../lib/session-cookie'
import { createSession, destroySession } from '../lib/sessions'
import { getOrCreateUserByEmail } from '../lib/users'

const STATE_COOKIE = 'oauth_state'

export const authRoutes = new Hono<AppEnv>()

const magicLinkRequest = z.object({ email: z.string().email() })

authRoutes.post('/magic-link', async (c) => {
  const parsed = magicLinkRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid email' }, 400)
  const email = parsed.data.email

  const token = await createLoginToken(c.env.DB, email)
  const verifyUrl = new URL('/api/auth/magic-link/verify', c.req.url)
  verifyUrl.searchParams.set('token', token)

  await getMailer(c.env).send({
    to: email,
    subject: 'Sign in to WaterLog',
    text: `Click to sign in (link expires in 10 minutes):\n${verifyUrl}`,
  })

  // Same response whether or not the address is known: no account enumeration.
  return c.json({ ok: true })
})

authRoutes.get('/magic-link/verify', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'invalid or expired token' }, 401)

  const email = await consumeLoginToken(c.env.DB, token)
  if (!email) return c.json({ error: 'invalid or expired token' }, 401)

  const user = await getOrCreateUserByEmail(c.env.DB, email)
  const session = await createSession(c.env.DB, user.id)
  setSessionCookie(c, session.token)
  return c.redirect(c.env.APP_URL)
})

authRoutes.get('/google', (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.json({ error: 'google oauth not configured' }, 503)
  const state = generateToken()
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  })
  return c.redirect(
    googleAuthorizeUrl({
      clientId: c.env.GOOGLE_CLIENT_ID,
      redirectUri: new URL('/api/auth/google/callback', c.req.url).toString(),
      state,
    }),
  )
})

authRoutes.get('/google/callback', async (c) => {
  const { code, state } = c.req.query()
  const expectedState = getCookie(c, STATE_COOKIE)
  deleteCookie(c, STATE_COOKIE, { path: '/' })
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: 'invalid oauth state' }, 401)
  }
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: 'google oauth not configured' }, 503)
  }

  const identity = await exchangeGoogleCode({
    code,
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    redirectUri: new URL('/api/auth/google/callback', c.req.url).toString(),
  })
  if (!identity || !identity.emailVerified) {
    return c.json({ error: 'google sign-in failed' }, 401)
  }

  // Creates-or-links on the email column (same account as magic link).
  const user = await getOrCreateUserByEmail(c.env.DB, identity.email)
  const session = await createSession(c.env.DB, user.id)
  setSessionCookie(c, session.token)
  return c.redirect(c.env.APP_URL)
})

authRoutes.post('/logout', async (c) => {
  const token = readSessionCookie(c)
  if (token) await destroySession(c.env.DB, token)
  clearSessionCookie(c)
  return c.json({ ok: true })
})
