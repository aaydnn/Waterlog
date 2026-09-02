// Dexie needs an IndexedDB implementation; the vitest environment is plain
// node, so tests that touch the local DB (sync engine, journal) run against
// fake-indexeddb instead of a real browser.
import 'fake-indexeddb/auto'
