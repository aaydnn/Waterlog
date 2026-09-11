import type { EnrichJob, User } from '@waterlog/schema'

/** Bindings + vars declared in wrangler.toml, as a Hono env. */
export interface ApiBindings {
  DB: D1Database
  PHOTOS: R2Bucket
  ENRICH_QUEUE: Queue<EnrichJob>
  APP_URL: string
  GOOGLE_CLIENT_ID: string
  /** Set via `wrangler secret put`; absent in local dev unless configured. */
  GOOGLE_CLIENT_SECRET?: string
  /** Set via `wrangler secret put`. Absent with no ALLOW_CONSOLE_MAIL opt-in, sign-in fails
   * closed (503) rather than printing magic links to the log — see lib/mailer.ts. */
  RESEND_API_KEY?: string
  /** `"true"` permits the ConsoleMailer, which prints the whole magic link. Local dev and tests
   * only: set it in `workers/api/.dev.vars`, NEVER in wrangler.toml's top-level [vars]. */
  ALLOW_CONSOLE_MAIL?: string
}

export type AppEnv = {
  Bindings: ApiBindings
  Variables: {
    /** Set by the requireAuth middleware. */
    user: User
  }
}
