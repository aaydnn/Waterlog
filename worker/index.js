// Cloudflare Worker entry (static assets + API).
//
// Deploys the built site from ./dist via the ASSETS binding and serves the
// waitlist API at POST /api/waitlist. The API logic is shared with the Pages
// Function in functions/api/waitlist.js, so both deploy targets behave the same.
//
// Routing: static assets are matched first (the Worker is not invoked for a
// path that maps to a file in dist/). Requests with no matching asset — like
// /api/waitlist — fall through to this fetch handler.

import { onRequestPost } from '../functions/api/waitlist.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api/waitlist') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return onRequestPost({ request, env })
    }

    // Anything else: hand back to the static assets (index.html, JS, CSS, …).
    return env.ASSETS.fetch(request)
  },
}
