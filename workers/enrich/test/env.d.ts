import type { D1Migration } from '@cloudflare/vitest-pool-workers/config'
import type { EnrichBindings } from '../src/env'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends EnrichBindings {
    TEST_MIGRATIONS: D1Migration[]
  }
}
