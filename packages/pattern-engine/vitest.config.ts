import { defineConfig } from 'vitest/config'

// Coverage here is a **ratchet**, not a fixed gate: the numbers below are counts of what is still
// uncovered today, and they may only ever go down (ADR-0018). Brief §9 asks for 100% branches, and
// that is still where this is going — but holding the package out of the workspace until it gets
// there blocks the integration and the parity gate, which are what actually prove the engine.
//
// A negative threshold is a maximum number of uncovered entities, not a percentage. That matters:
// the instrumented file set shifts by a branch or two between a direct run and `pnpm -r test`, so
// a percentage floor pinned this tightly would flake. The uncovered *count* is stable.
//
// Two rules when you touch this file:
//   1. Lower a number after you earn it. Never raise one to make a red run go green.
//   2. An unreachable branch gets deleted, not ignored. No `c8 ignore` comments — the precedent is
//      `packages/patterns`, which reached a true 100% by removing two branches that could not fire.
//
// `packages/patterns` (v1) stays at a hard 100% and is unaffected by this.
//
// Tests live in `test/`, not beside the source, so `include` here is not the patterns layout.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts is re-exports; types.ts is type declarations with no runtime behaviour to cover.
      exclude: ['src/index.ts', 'src/types.ts'],
      reporter: ['text-summary'],
      // Measured 2026-09-20: 96 uncovered branches, 8 uncovered statements and lines, 0 functions.
      // Functions stays a true percentage because it is genuinely at 100 and should stay there.
      thresholds: { branches: -96, functions: 100, lines: -8, statements: -8 },
    },
  },
})
