import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { generateToken } from '../lib/crypto'
import { exchangeGoogleCode, googleAuthorizeUrl } from '../lib/google'
import {
  createLoginToken,
  consumeLoginToken,
  normalizeEmail,
  MAX_EMAIL_LENGTH,
} from '../lib/magic-link'
import { getMailer, MailerNotConfiguredError } from '../lib/mailer'
import {
  consumeRateLimit,
  magicLinkEmailBucket,
  magicLinkIpBucket,
  MAGIC_LINK_PER_EMAIL,
  MAGIC_LINK_PER_IP,
  UNKNOWN_IP,
} from '../lib/rate-limit'
import { clearSessionCookie, readSessionCookie, setSessionCookie } from '../lib/session-cookie'
import { createSession, destroySession } from '../lib/sessions'
import { getOrCreateUserByEmail } from '../lib/users'

const STATE_COOKIE = 'oauth_state'

export const authRoutes = new Hono<AppEnv>()

// Bounded before anything touches the DB: an address longer than RFC 5321 allows is not a real
// mailbox, and an unbounded string would otherwise be hashed, stored, and mailed.
const magicLinkRequest = z.object({
  email: z.string().trim().toLowerCase().max(MAX_EMAIL_LENGTH).email(),
})

authRoutes.post('/magic-link', async (c) => {
  const parsed = magicLinkRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid email' }, 400)
  const email = normalizeEmail(parsed.data.email)

  // Resolved before the token is minted. A misconfigured environment must not leave a live
  // credential in the table for a link nobody could receive — and must never fall through to a
  // mailer that prints the link to the log.
  let mailer
  try {
    mailer = getMailer(c.env)
  } catch (err) {
    if (!(err instanceof MailerNotConfiguredError)) throw err
    console.error(err.message)
    return c.json({ error: 'sign-in email is unavailable' }, 503)
  }

  // Two quotas, IP first (the broader one), then the address. Both are checked before a token
  // exists, so a limited request creates nothing and sends nothing. The body is generic and
  // identical in both cases: a 429 must not tell a caller which limit they tripped, since the
  // per-address one only trips for an address they were already naming.
  const ip = c.req.header('CF-Connecting-IP') ?? UNKNOWN_IP
  const byIp = await consumeRateLimit(c.env.DB, magicLinkIpBucket(ip), MAGIC_LINK_PER_IP)
  const limit = byIp.allowed
    ? await consumeRateLimit(c.env.DB, await magicLinkEmailBucket(email), MAGIC_LINK_PER_EMAIL)
    : byIp
  if (!limit.allowed) {
    return c.json({ error: 'too many requests' }, 429, {
      'retry-after': String(limit.retryAfterSeconds),
    })
  }

  const token = await createLoginToken(c.env.DB, email)
  // Built from APP_URL, not c.req.url: in production the request reaches this Worker through
  // the Pages /api/* proxy, so c.req.url is the *.workers.dev origin. A link to that host would
  // set the session cookie on the wrong origin and the app would never see it.
  const verifyUrl = new URL('/api/auth/magic-link/verify', c.env.APP_URL)
  verifyUrl.searchParams.set('token', token)

  await mailer.send({
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
      redirectUri: new URL('/api/auth/google/callback', c.env.APP_URL).toString(),
      state,
    }),
  )
})

authRoutes.get('/google/callback', async (c) => {
  const { code, state } = c.req.query()
  const expectedState = getCookie(c, STATE_COOKIE)
  deleteCookie(c, STATE_COOKIE, { path: '/' })
  // Distinguished rather than collapsed into one message: each case has a different cause and
  // a different fix, and they are otherwise indistinguishable from the client.
  if (!code || !state) {
    return c.json({ error: 'invalid oauth state: provider did not return a code and state' }, 401)
  }
  if (!expectedState) {
    // The cookie is set on /api/auth/google and must come back on this request. It won't if the
    // sign-in began in a different browser context (an installed PWA has its own cookie jar, so
    // a flow that hops out to Safari lands here without it), if site data was cleared mid-flow,
    // or if more than the cookie's 10 minutes elapsed.
    return c.json({ error: 'invalid oauth state: no state cookie on the callback' }, 401)
  }
  if (state !== expectedState) {
    // A second /api/auth/google overwrote the first's cookie, so an older tab's callback loses.
    return c.json({ error: 'invalid oauth state: state did not match the cookie' }, 401)
  }
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: 'google oauth not configured' }, 503)
  }

  const identity = await exchangeGoogleCode({
    code,
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    redirectUri: new URL('/api/auth/google/callback', c.env.APP_URL).toString(),
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
