import type { PatternJob } from '@waterlog/schema'

/** Bindings declared in wrangler.toml. */
export interface CronBindings {
  DB: D1Database
  /** The nightly sweep produces onto this queue; the consumer below it reads from the same one,
   * so one angler is one message with its own budget and its own retries. */
  PATTERN_QUEUE: Queue<PatternJob>
  /** VAPID keypair for Web Push. Set with `wrangler secret put`; absent locally, and the push is
   * skipped rather than failing the recompute (packet §06: best-effort, never blocking). */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  /** `mailto:` or `https:` contact the push service can reach us at, per RFC 8292. */
  VAPID_SUBJECT?: string
  /** Where a push notification's link should land. */
  APP_URL?: string
}
