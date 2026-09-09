# Epic 3 — Journal & Stats: acceptance

Packet §10 criterion: **"Numbers reconcile with raw SQL spot-checks."** Task sheet: **T3.1** and
**T3.2**.

## T3.1 — filters compose; conditions panel shows partial state honestly

**Filters compose.** `listJournal` ANDs every supplied filter onto one predicate, and the client
sends all set filters on every request rather than one at a time. Proven both ends: four API
tests (water+lure narrower than either alone, filter+date range, an empty page when the
combination matches nothing, and every filter surviving a page turn) and two client tests (a
second filter does not drop the first; Clear drops all of them).

**Partial state, honestly.** The conditions panel omits a reading it does not have — never a zero
— labels water temperature with its provenance (measured / gauge / modeled), and reads
`enrich_status` with `source_meta` to say *why* something is absent. The distinction that matters:
a gauge that exists and failed says it will fill in if the source comes back, while a water with
no gauge in range says none covers it — permanent, and not a failure (ADR-0008). An outright
failure says so; an unparseable `source_meta` degrades to showing the readings without a note.
Partial is never treated as empty: whatever was fetched is still displayed alongside the note.

## T3.2 — numbers reconcile with raw SQL

### Automated

`workers/api/test/journal.test.ts` (21 tests) drives the real queries against a real D1 through
`vitest-pool-workers`, asserting exact figures over a known fixture: 6 catches across 3 trips
(4h + 2h + 1h, one of them a skunk) on 2 waters. It covers reverse-chron ordering, the joined
lure and water names, per-user isolation, each filter, inclusive date bounds, keyset paging with
no repeated or skipped row, and the stats totals and all three breakdowns — including a trip with
no water in its own bucket, an open trip counted in trips but not in hours, and an angler who has
logged nothing.

`apps/web` (126 tests) covers the journal's rendering, filters, paging and offline fallback; the
detail sheet's units and its handling of readings a water will never have; the stats sentence and
breakdowns; the session gate; and imperial display conversion.

### Manual spot-check — 2026-09-08, local D1 after `pnpm migrate && pnpm seed`

Dev seed plus 12 catches that synced out of the PWA's offline queue during the same session
(they arrived as 9 auto-created 1h orphan trips, F2). `GET /api/stats` against raw SQL over the
same rows:

| Figure | `/api/stats` | Raw SQL |
| --- | --- | --- |
| catches | 24 | 24 |
| trips | 12 | 12 |
| hours on water | 39.1 | 39.1 |
| skunked trips | 3 | 3 |
| species | 6 | 6 |
| by species | 16 / 3 / 2 / 1 / 1 / 1 | 16 / 3 / 2 / 1 / 1 / 1 |
| by month | 2026-09 12·9, 2026-07 0·1, 2026-06 12·2 | same |
| by water | none 12·9, Percy Priest 7·2, Caney Fork 5·1 | same |

Exact on every figure, breakdowns included.

## Deviations

- **ADR-0009** — water bodies are selected at trip start, ranked by distance, rather than
  auto-detected at ≤300 m. Written while building this epic, because trips could not reference a
  water at all before it: `startTrip()` hardcoded `water_body_id: null` and no endpoint existed.

## Known gaps entering Epic 4

- **Sign-in gates the app, but the offline queue does not know who queued it.** Catches captured
  before signing in flush to whichever account signs in next on that device. Correct for a
  single-angler device and it is how the seeded rows above arrived, but it needs a guard (clear
  the queue on sign-out, or stamp it with a user) before the beta puts two anglers on one phone.
- **No trip auto-close** (T1.4). An open trip has no duration, so it contributes nothing to
  hours-on-water while it runs and a forgotten one inflates it badly when it finally ends. Epic 4
  divides by those hours.
- **Real-water validation still pending** — one real catch and one real skunked trip end to end,
  which needs an actual fishing trip. Same open item Epic 2 carries.
