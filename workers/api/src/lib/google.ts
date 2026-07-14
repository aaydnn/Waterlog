// Minimal Google OAuth (authorization code flow). The id_token comes straight
// from Google's token endpoint over TLS, so its claims are trusted without
// local signature verification.

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export function googleAuthorizeUrl(opts: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', opts.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email')
  url.searchParams.set('state', opts.state)
  return url.toString()
}

export interface GoogleIdentity {
  email: string
  emailVerified: boolean
}

export async function exchangeGoogleCode(opts: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}): Promise<GoogleIdentity | null> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) return null

  const body = (await res.json()) as { id_token?: string }
  if (!body.id_token) return null
  const claims = decodeJwtPayload(body.id_token)
  if (typeof claims?.email !== 'string') return null
  return { email: claims.email, emailVerified: claims.email_verified === true }
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const payload = jwt.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replaceAll('-', '+').replaceAll('_', '/')
    return JSON.parse(atob(base64)) as Record<string, unknown>
  } catch {
    return null
  }
}
