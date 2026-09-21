import type { D1Migration } from '@cloudflare/vitest-pool-workers/config'
import type { CronBindings } from '../src/env'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends CronBindings {
    TEST_MIGRATIONS: D1Migration[]
  }
}
