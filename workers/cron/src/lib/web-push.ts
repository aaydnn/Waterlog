/**
 * Web Push, spelled out: VAPID authentication (RFC 8292) and `aes128gcm` message encryption
 * (RFC 8291), on Web Crypto only.
 *
 * Hand-written rather than pulled in, because the usual libraries assume Node's crypto module and
 * this runs in workerd. Everything here is standard and testable: the key derivation is a fixed
 * chain of HMACs with published test vectors, and the body layout is a byte-for-byte assembly.
 *
 * The payload is encrypted end to end. The push service — Google, Apple, Mozilla — forwards a
 * blob it cannot read, which is the only reason it is acceptable to put "WaterLog found your first
 * pattern" through third-party infrastructure at all.
 */

export interface VapidKeys {
  /** Base64url, 65-byte uncompressed P-256 point. */
  publicKey: string
  /** Base64url, 32-byte private scalar. */
  privateKey: string
  /** `mailto:` or `https:` contact, per RFC 8292 §2.1. */
  subject: string
}

export interface PushTarget {
  endpoint: string
  /** Base64url, the subscriber's 65-byte public key. */
  p256dh: string
  /** Base64url, the subscriber's 16-byte auth secret. */
  auth: string
}

const encoder = new TextEncoder()

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data))
}

/** HKDF with a single-block expand, which is all RFC 8291 ever needs. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm)
  const okm = await hmac(prk, concat(info, Uint8Array.of(1)))
  return okm.slice(0, length)
}

/** The VAPID JWT, signed ES256. `aud` is the push service's origin and nothing else. */
export async function signVapidToken(keys: VapidKeys, audience: string, now: number): Promise<string> {
  const publicKey = base64UrlDecode(keys.publicKey)
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    d: keys.privateKey,
    ext: true,
  }
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )

  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        // Twelve hours. The spec allows twenty-four; shorter costs nothing here because a token is
        // minted per send.
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  )
  const signed = `${header}.${payload}`
  // Web Crypto returns the raw r||s pair ECDSA in JWS wants, not the DER encoding.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, encoder.encode(signed)),
  )
  return `${signed}.${base64UrlEncode(signature)}`
}

/** Record size. One record is plenty: every notification this product sends is a short sentence. */
const RECORD_SIZE = 4096

/**
 * RFC 8291 §3.1: derive a content key from the shared ECDH secret and the subscriber's auth
 * secret, encrypt one record, and lay out the `aes128gcm` body.
 */
export async function encryptPayload(
  target: PushTarget,
  plaintext: Uint8Array,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): Promise<Uint8Array> {
  const subscriberPublic = base64UrlDecode(target.p256dh)
  const authSecret = base64UrlDecode(target.auth)

  const ephemeral = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const ephemeralPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer,
  )
  const subscriberKey = await crypto.subtle.importKey(
    'raw',
    subscriberPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // `public` is what WebCrypto and workerd both call it. @cloudflare/workers-types renames it
      // to `$public` because `public` is reserved in their IDL generator, so the cast keeps the
      // runtime-correct name.
      { name: 'ECDH', public: subscriberKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ephemeral.privateKey,
      256,
    ),
  )

  // The key-derivation chain, exactly as the RFC lays it out: the auth secret salts the shared
  // secret, the result is bound to both public keys, and only then does the record salt enter.
  const keyInfo = concat(
    encoder.encode('WebPush: info\0'),
    subscriberPublic,
    ephemeralPublic,
  )
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32)
  const contentKey = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', contentKey, { name: 'AES-GCM' }, false, ['encrypt'])
  // 0x02 is the last-record delimiter; there is only ever one record here.
  const record = concat(plaintext, Uint8Array.of(2))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record),
  )

  const header = new Uint8Array(21)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = ephemeralPublic.length
  return concat(header, ephemeralPublic, ciphertext)
}

export interface PushResult {
  status: number
  /** True when the push service says this subscription is gone for good and should be deleted. */
  expired: boolean
}

/** One notification to one browser. Returns the outcome rather than throwing on a rejection: a
 * dead subscription is an ordinary, expected answer. */
export async function sendPush(
  keys: VapidKeys,
  target: PushTarget,
  payload: unknown,
  now: number = Date.now(),
  ttlSeconds = 24 * 60 * 60,
): Promise<PushResult> {
  const audience = new URL(target.endpoint).origin
  const token = await signVapidToken(keys, audience, now)
  const body = await encryptPayload(target, encoder.encode(JSON.stringify(payload)))

  const response = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${token}, k=${keys.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttlSeconds),
      Urgency: 'normal',
    },
    body,
  })

  // 404 means the endpoint never existed, 410 that it has been revoked. Both are permanent.
  return { status: response.status, expired: response.status === 404 || response.status === 410 }
}
