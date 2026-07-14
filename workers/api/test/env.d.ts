import type { D1Migration } from '@cloudflare/vitest-pool-workers/config'
import type { ApiBindings } from '../src/env'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends ApiBindings {
    TEST_MIGRATIONS: D1Migration[]
  }
}
