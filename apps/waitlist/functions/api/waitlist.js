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

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function normalizePhone(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const digits = value.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return null // invalid
  return digits
}

export async function onRequestPost({ request, env }) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Malformed request.' }, 400)
  }

  // Honeypot: real people never fill this. Pretend success, write nothing.
  if (body && typeof body.company === 'string' && body.company.trim() !== '') {
    return json({ ok: true }, 200)
  }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!isValidEmail(email)) {
    return json({ error: 'A valid email is required.' }, 400)
  }

  const phone = normalizePhone(body?.phone)
  if (phone === null) {
    return json({ error: 'Phone number is not valid.' }, 400)
  }

  if (!env.WAITLIST) {
    return json({ error: 'Waitlist storage is not configured.' }, 500)
  }

  const key = `email:${email}`

  // Dedupe on email.
  const existing = await env.WAITLIST.get(key)
  if (existing !== null) {
    return json({ error: "You're already on the list — good instincts." }, 409)
  }

  const record = {
    email,
    phone, // '' when not provided
    created_at: new Date().toISOString(),
  }

  await env.WAITLIST.put(key, JSON.stringify(record))

  return json({ ok: true }, 200)
}

// Only POST is exported, so Pages answers any other method with 405 on its own.
