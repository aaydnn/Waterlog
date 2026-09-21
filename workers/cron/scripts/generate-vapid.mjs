// Generates a VAPID keypair in exactly the shape `src/lib/web-push.ts` expects, and proves it
// before you trust it.
//
//   node scripts/generate-vapid.mjs "mailto:you@example.com"
//
// The private key is written to `.vapid.json` (gitignored) and deliberately NOT printed, so it
// does not end up in a terminal scrollback, a screen share, or an agent transcript. Feed it to
// wrangler from the file.
//
// Why not `npx web-push generate-vapid-keys`: it emits the same two values, but this script also
// round-trips them through the same import path the worker uses, so an encoding mistake fails here
// rather than as a silent 401 from a push service at 08:00 UTC.

import { writeFileSync } from 'node:fs'
import { webcrypto as crypto } from 'node:crypto'

const subject = process.argv[2]

if (!subject || !/^(mailto:|https:\/\/)/.test(subject)) {
  console.error('Usage: node scripts/generate-vapid.mjs "mailto:you@example.com"')
  console.error('RFC 8292 requires a mailto: or https: subject — a push service can reject others.')
  process.exit(1)
}

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
])

const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)

const publicKey = b64url(raw)
const privateKey = jwk.d

// ── Proof, not assumption ────────────────────────────────────────────────────────────────────
// Rebuild the signing key the way `signVapidToken` does — from the base64url public key plus the
// `d` scalar — then sign and verify. If the encoding is wrong, this throws here.
if (raw.length !== 65 || raw[0] !== 0x04) {
  throw new Error(`expected a 65-byte uncompressed point, got ${raw.length} starting ${raw[0]}`)
}

const rebuilt = await crypto.subtle.importKey(
  'jwk',
  {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(raw.slice(1, 33)),
    y: b64url(raw.slice(33, 65)),
    d: privateKey,
    ext: true,
  },
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign'],
)

const message = new TextEncoder().encode('waterlog vapid self-test')
const signature = await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' },
  rebuilt,
  message,
)
const ok = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' },
  pair.publicKey,
  signature,
  message,
)

if (!ok) throw new Error('self-test failed: the rebuilt signing key does not match the public key')

writeFileSync(
  new URL('../.vapid.json', import.meta.url),
  JSON.stringify({ publicKey, privateKey, subject }, null, 2) + '\n',
)

console.log('Self-test passed: ES256 signature verified against the public key.\n')
console.log('Wrote workers/cron/.vapid.json (gitignored). The private key is in that file only.\n')
console.log('VAPID_SUBJECT     ', subject)
console.log('VAPID_PUBLIC_KEY  ', publicKey)
console.log('VAPID_PRIVATE_KEY  <in .vapid.json — not printed>\n')
console.log('Next, from workers/cron:')
console.log('  node -e "process.stdout.write(require(\'./.vapid.json\').privateKey)" | npx wrangler secret put VAPID_PRIVATE_KEY')
console.log('  node -e "process.stdout.write(require(\'./.vapid.json\').publicKey)"  | npx wrangler secret put VAPID_PUBLIC_KEY')
console.log('  node -e "process.stdout.write(require(\'./.vapid.json\').subject)"    | npx wrangler secret put VAPID_SUBJECT')
console.log('\nThen the same public key on the API worker, from workers/api:')
console.log('  node -e "process.stdout.write(require(\'../cron/.vapid.json\').publicKey)" | npx wrangler secret put VAPID_PUBLIC_KEY')
