import { defineConfig } from 'vitest/config'

// Packet §08/§10: this package is the moat, and 100% branch coverage is an acceptance criterion
// rather than an aspiration. The thresholds run with the normal `pnpm test`, so CI fails on a new
// uncovered branch instead of someone noticing one later.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts is re-exports; fixtures.ts is scaffolding for the specs, not engine code.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/fixtures.ts'],
      reporter: ['text-summary'],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
})
