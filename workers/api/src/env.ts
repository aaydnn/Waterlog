/** Bindings + vars declared in wrangler.toml, as a Hono env. */
export interface ApiBindings {
  DB: D1Database
  PHOTOS: R2Bucket
  ENRICH_QUEUE: Queue
  APP_URL: string
  GOOGLE_CLIENT_ID: string
  /** Set via `wrangler secret put`; absent in local dev unless configured. */
  GOOGLE_CLIENT_SECRET?: string
}

export type AppEnv = { Bindings: ApiBindings }
