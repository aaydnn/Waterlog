import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

// Tests run inside workerd with a real (local) D1; migrations are applied
// in test/apply-migrations.ts before each test file.
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('../../migrations')
  return {
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // getMailer fails closed without this (a missing RESEND_API_KEY must not silently
              // print sign-in links). Tests read the link off the console the same way local dev
              // does, so they opt in explicitly here rather than in wrangler.toml's [vars],
              // which is production configuration.
              ALLOW_CONSOLE_MAIL: 'true',
            },
          },
        },
      },
    },
  }
})
