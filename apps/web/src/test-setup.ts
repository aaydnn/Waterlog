// Dexie needs an IndexedDB implementation; the vitest environment is plain
// node, so tests that touch the local DB (sync engine, journal) run against
// fake-indexeddb instead of a real browser.
import 'fake-indexeddb/auto'
// Component tests opt into `@vitest-environment jsdom` per-file; this adds
// the jest-dom matchers (toBeInTheDocument, etc.) for all test files.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// `test.globals` is off, so testing-library's own afterEach auto-cleanup
// never registers — do it explicitly, once, for every test file.
afterEach(cleanup)
