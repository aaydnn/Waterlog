import type { PatternEngineJob, PatternJob } from '@waterlog/schema'

/** Bindings declared in wrangler.toml. */
export interface CronBindings {
  DB: D1Database
  /** The nightly sweep produces onto this queue; the consumer below it reads from the same one,
   * so one angler is one message with its own budget and its own retries. */
  PATTERN_QUEUE: Queue<PatternJob>
  /** The v2 engine's own queue (ADR-0017). Separate from v1's rather than discriminated inside
   * one, so a slow v2 run cannot delay a v1 recompute and the two have independent retries and
   * backlogs — the same isolation argument that made v1 one-angler-per-message. */
  ENGINE_QUEUE: Queue<PatternEngineJob>
  /** VAPID keypair for Web Push. Set with `wrangler secret put`; absent locally, and the push is
   * skipped rather than failing the recompute (packet §06: best-effort, never blocking). */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  /** `mailto:` or `https:` contact the push service can reach us at, per RFC 8292. */
  VAPID_SUBJECT?: string
  /** Where a push notification's link should land. */
  APP_URL?: string
  /**
   * Opt-in switch for the parity harness route (brief §7). Absent, `GET /__parity` 404s exactly
   * as an unknown path would, so a deployed worker exposes nothing.
   *
   * Same shape and the same reason as the ConsoleMailer flag in ADR-0011: the capability is real
   * and useful locally, so it is opted into by a gitignored `.dev.vars`, never by `wrangler.toml`.
   * Do not set it in production — it reads one angler's whole history.
   */
  ALLOW_PARITY_ROUTE?: string
}
