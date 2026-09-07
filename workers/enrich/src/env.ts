/** Bindings declared in wrangler.toml. */
export interface EnrichBindings {
  DB: D1Database
  /** Optional locally; configure as a Worker secret for production USGS quotas. */
  USGS_API_KEY?: string
}
