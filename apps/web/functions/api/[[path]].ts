// Cloudflare Pages Function: proxies every /api/* request to the API Worker.
//
// The client fetches relative paths (`/api/sync`) with `credentials: 'include'`, and the API
// sets a host-only, SameSite=Lax session cookie. Pointing the client straight at
// *.workers.dev instead would make every call cross-origin, which needs CORS, needs
// SameSite=None, and hands the session cookie to a different host than the one serving the app.
// Proxying keeps the whole thing same-origin, so none of that applies.
//
// Without this, Pages answers /api/* with the SPA's index.html and a 200, so `res.json()`
// throws on every call and the client's catch blocks silently swallow it.

interface Env {
  /** Override per environment; defaults to the deployed API Worker. */
  API_ORIGIN?: string
}

const DEFAULT_API_ORIGIN = 'https://waterlog-api.aydenchristopheroconnell.workers.dev'

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context
  const incoming = new URL(request.url)
  const target = new URL(incoming.pathname + incoming.search, env.API_ORIGIN ?? DEFAULT_API_ORIGIN)

  // `redirect: 'manual'` matters: the auth flows answer with 302s that the *browser* has to
  // follow (to Google, and back to the app). Following them here would swallow the redirect
  // and return the final body to fetch() instead.
  return fetch(new Request(target, request), { redirect: 'manual' })
}
