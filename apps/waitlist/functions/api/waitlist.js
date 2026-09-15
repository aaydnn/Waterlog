// Cloudflare Pages Function — POST /api/waitlist
//
// Writes { email, phone, created_at } to Cloudflare KV, deduping on email.
//
// ── Setup (KV binding) ──────────────────────────────────────────────────────
// This function expects a KV namespace bound as `WAITLIST`.
//
// Dashboard:
//   Workers & Pages → your Pages project → Settings → Functions →
//   KV namespace bindings → Add binding
//     Variable name: WAITLIST
//     KV namespace:  (create one, e.g. "waterlog-waitlist")
//   Add the binding for both Production and Preview.
//
// Wrangler (local dev / CI), in wrangler.toml:
//   [[kv_namespaces]]
//   binding    = "WAITLIST"
//   id         = "<your-kv-namespace-id>"
//   preview_id = "<your-preview-kv-namespace-id>"
//
// Create the namespace from the CLI:
//   npx wrangler kv namespace create WAITLIST
//   npx wrangler kv namespace create WAITLIST --preview
//
// Run locally with the binding wired up:
//   npm run build && npx wrangler pages dev dist
// ────────────────────────────────────────────────────────────────────────────

const json = (data, status) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// RFC 5321 caps a forward-path at 254 characters; the phone bound is generous enough for an
// international number with separators. Both are checked before anything is stored, so a
// megabyte of "email" never reaches KV.
const MAX_EMAIL_LENGTH = 254
const MAX_PHONE_LENGTH = 32

// Per-IP submission cap. Signing up is a once-in-a-lifetime act, so 10 attempts an hour is
// generous for a real person retrying a typo and still blunts a scripted flood. The window
// rolls: each counted attempt re-stamps the TTL, so sustained abuse stays locked out.
const IP_LIMIT = 10
const IP_WINDOW_SECONDS = 60 * 60

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function normalizePhone(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  if (value.length > MAX_PHONE_LENGTH) return null // invalid
  const digits = value.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return null // invalid
  return digits
}

/**
 * Counts one attempt against the caller's IP and reports whether they are over the cap.
 *
 * KV is eventually consistent, so a burst fired in parallel from one IP can slip a few extra
 * writes past the counter before it settles. That is acceptable here: this is a speed bump on a
 * public form, not an authorisation boundary, and the KV key remains the real dedupe.
 *
 * A request with no CF-Connecting-IP shares the 'unknown' bucket rather than skipping the
 * check — an unattributable request is still a request.
 */
async function overIpLimit(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const key = `ip:${ip}`
  const stored = await env.WAITLIST.get(key)
  const count = Number.parseInt(stored ?? '0', 10) || 0
  if (count >= IP_LIMIT) return true
  await env.WAITLIST.put(key, String(count + 1), { expirationTtl: IP_WINDOW_SECONDS })
  return false
}

export async function onRequestPost({ request, env }) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Malformed request.' }, 400)
  }

  if (!env.WAITLIST) {
    return json({ error: 'Waitlist storage is not configured.' }, 500)
  }

  // Counted before the honeypot and before validation: a bot that trips the honeypot on every
  // request, or posts garbage, is exactly what the cap is for.
  if (await overIpLimit(env, request)) {
    return json({ error: 'Too many requests. Try again later.' }, 429)
  }

  // Honeypot: real people never fill this. Pretend success, write nothing.
  if (body && typeof body.company === 'string' && body.company.trim() !== '') {
    return json({ ok: true }, 200)
  }

  const rawEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (rawEmail.length > MAX_EMAIL_LENGTH || !isValidEmail(rawEmail)) {
    return json({ error: 'A valid email is required.' }, 400)
  }
  const email = rawEmail

  const phone = normalizePhone(body?.phone)
  if (phone === null) {
    return json({ error: 'Phone number is not valid.' }, 400)
  }

  const key = `email:${email}`

  // Dedupe on email — the first submission's record and timestamp stand.
  //
  // The response is the same 200 either way. A distinct 409 for an address already on the list
  // turned this endpoint into a membership oracle: anyone could ask it, one address at a time,
  // who had signed up. Whether someone is on a fishing waitlist is theirs to disclose, not a
  // fact a public form should answer, and the honeypot in front of it stops nobody who cares.
  const existing = await env.WAITLIST.get(key)
  if (existing === null) {
    await env.WAITLIST.put(
      key,
      JSON.stringify({
        email,
        phone, // '' when not provided
        created_at: new Date().toISOString(),
      }),
    )
  }

  return json({ ok: true }, 200)
}

// Only POST is exported, so Pages answers any other method with 405 on its own.
