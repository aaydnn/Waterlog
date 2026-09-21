# Coding-Agent Brief — WaterLog Pattern Engine v2

> Paste this whole file into Claude Code at the repo root. The reference implementation ships alongside it as `packages/pattern-engine/` (tests passing). Your job is integration: schema, capture, enrichment, cron, persistence, parity, and closing the branch-coverage gap. Do not change engine math without a failing test that justifies it.

---

## 0. Ground rules

- `packages/pattern-engine` stays pure: no I/O, no `Date.now()`, no dependencies. `now` is injected.
- Extend `packages/schema` (Zod) first for every new payload; never define a shape twice.
- Every PR lands with tests. Engine math changes bump `ENGINE_VERSION` in `src/version.ts` (lifecycle uses it to tell "engine changed" from "fishing changed").
- The existing `packages/patterns` (v1) stays in place until the parity gate in §7 passes.

## 1. What v2 is

A personal fishing research engine: **observe → discover → challenge → confirm → adapt**. Every surfaced claim carries its evidence receipt, its skeptic checks, what might be misleading it, and what would settle it.

### Ideas built (numbers from the idea list)

| Area | Ideas | Where |
|---|---|---|
| Measured exposure | 1 tie-on sessions, 2 evidence quality, 3 fishable minutes, 5 target species | `exposure.ts`, `engine.ts` |
| Honest comparisons | 4 zero-catch negatives, 6 same-water/season baselines with disclosed broadening, 12 shrinkage + tie groups | `analyze.ts`, `briefing.ts` |
| False-discovery defense | 7 leave-best-trip-out, 8 trip-level dispersion + week replication, 9 BH across everything searched, 10 curated interactions | `analyze.ts`, `family.ts` |
| Environment | 13 prior-48h rain, 14 warming vs cooling, 16 flow trend, 22 real sunset | `dimensions.ts` |
| Explanations | 24/39 competing explanations (stratified re-estimation), 46 "doesn't matter", 68 blind spots | `family.ts` |
| Beliefs & tests | 37/38 hypothesis notebook, 40/47 next useful experiment, 43 one question that matters, 44 falsifier, 45 prospective confirmation | `hypotheses.ts`, `exposure.ts`, `lifecycle.ts` |
| Decisions | 11 boundary of experience, 36 bigger-fish outcome, 49 time-boxed window, 57/58/59 time-to-first-fish, skunk odds, upside, 65 analogs from both sides | `briefing.ts`, `family.ts` |
| Trust surface | 61 receipts, 62 lifecycle, 63 what changed my mind, 67 post-trip lesson, 76 expiration & revival, 79 skeptic checks | `lifecycle.ts`, `tripLesson.ts` |

### Deliberately deferred (and why)

- **18 thresholds, 23 regimes, 74 sequence shapes, 75 session states** — breakpoint/cluster searches overfit badly at the data volumes a single angler produces; revisit once real users have 200+ trips.
- **21 wind-vs-shoreline, 29 running depth, 31/32 spot passes & rest** — need shoreline geometry or precise GPS exposure; privacy and effort cost too high for MVP+1.
- **25 lure attributes, 26/27 technique skill curves, 28 retrieve, 35 bite/landing** — extra logging taps. Add only after tie-on tap adoption is measured.
- **52/53 forecast sensitivity, 55/56 live stay-or-move, 78 counterfactuals** — require calibrated predictive models; the transparent prediction record (71) must exist first.
- **69 NL questions, 70 lab, 82/83 crew research, 84 knowledge export** — presentation layers over the structured records v2 already produces. Crew Mode can consume `FindingRecord` directly later.

## 2. Schema — migration `00NN_pattern_engine_v2.sql`

Check existing migrations first: `offering_sessions` may already exist from the F14 work. If it does, reconcile columns instead of recreating.

```sql
-- Tie-on intervals (idea 1). end_at NULL = until next tie-on or trip end.
CREATE TABLE IF NOT EXISTS offering_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  lure_id TEXT NOT NULL REFERENCES lures(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  source TEXT NOT NULL DEFAULT 'tap',          -- tap | estimated
  client_id TEXT UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_offering_sessions_trip ON offering_sessions(trip_id, start_at);

-- Non-fishing time (idea 3).
CREATE TABLE trip_pauses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  client_id TEXT UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX idx_trip_pauses_trip ON trip_pauses(trip_id);

ALTER TABLE trips ADD COLUMN effort_source TEXT NOT NULL DEFAULT 'manual';  -- timer | manual | reconstructed
ALTER TABLE trips ADD COLUMN target_species TEXT;                          -- species slug | 'mixed' | NULL

-- Trajectory + solar enrichment (ideas 13, 14, 16, 22). All nullable.
ALTER TABLE conditions ADD COLUMN minutes_to_sunset INTEGER;
ALTER TABLE conditions ADD COLUMN water_temp_delta_72h_c REAL;
ALTER TABLE conditions ADD COLUMN precip_prev_48h_mm REAL;
ALTER TABLE conditions ADD COLUMN discharge_delta_24h_pct REAL;

-- One row per finding per run's latest state. Receipt JSON from toPersisted().
CREATE TABLE pattern_findings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,                             -- scope::outcome::dimension::bucket
  scope TEXT NOT NULL, outcome TEXT NOT NULL,
  dimension TEXT NOT NULL, bucket TEXT NOT NULL,
  direction TEXT NOT NULL,                       -- positive | negative
  tier TEXT,                                     -- early | promising | solid | NULL (not surfaced now)
  lifecycle TEXT NOT NULL,                       -- hypothesis | emerging | repeated | confirmed | weakening | retired
  multiplier REAL NOT NULL,
  finding_json TEXT,                             -- Finding (NULL when not surfaced this run)
  record_json TEXT NOT NULL,                     -- FindingRecord (lifecycle state carried between runs)
  engine_version TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idx_findings_feed ON pattern_findings(user_id, lifecycle, tier);

CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  statement TEXT NOT NULL,                       -- angler's words, display only
  dimension TEXT NOT NULL, bucket TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all', outcome TEXT NOT NULL DEFAULT 'all',
  expectation TEXT NOT NULL,                     -- better | worse | no_difference
  result_json TEXT,                              -- latest HypothesisResult
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE pattern_runs (                      -- family metadata, profiles, experiments, questions, data quality
  user_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);
```

Keep `pattern_cache`. During the transition the consumer also writes v2 findings into it via an adapter (§7) so the existing feed UI keeps working.

## 3. Capture (client) — the minimum that unlocks v2

1. **Tie-on tap.** On the active-trip screen, a persistent "Tied on: [lure] ▾" chip. Changing it writes an `offering_sessions` row (`source='tap'`) through the existing idempotent sync (`client_id` ULID). Logging a catch with a lure that isn't tied on silently opens a session at that catch time **only if the user confirms** the prompt; otherwise leave it and let the engine raise `catch_offering_unmatched`.
2. **Pause.** One tap toggles a pause. Timer-started trips set `effort_source='timer'`; retro-entered trips `manual`; F10 camera-roll and orphan auto-created trips `reconstructed`.
3. **Target chip.** Optional on trip start: last-used species, "Mixed", or skip (NULL).
4. **Questions.** Render `result.questions` as dismissible one-liners on the trip detail screen. Answers become normal edits (add a session, extend a trip) — the engine never stores answers itself.

None of these may block catch logging or add a required field. Offline-first rules apply unchanged.

## 4. Enrichment (Epic 2 extension)

Add to the trip-hour conditions writer, all best-effort:

- `minutes_to_sunset`: from `astro.ts` sunset at the water centroid, same convention as `minutes_from_sunrise` (negative = after sunset).
- `precip_prev_48h_mm`: sum of Open-Meteo hourly precipitation over the 48h before the hour. One archive call per trip covering `started_at − 72h … ended_at` also serves the next item.
- `water_temp_delta_72h_c`: USGS water temp now minus 72h earlier at the matched gauge. NULL without gauge coverage. Do not substitute air temperature.
- `discharge_delta_24h_pct`: USGS discharge % change over 24h. NULL if either reading is missing or prior discharge is 0.

Unit-test boundary values (per the existing rule: boundaries in unit tests, not dogfooding). Backfill historical rows via the T2.4 backfill queue.

## 5. Cron + queue wiring

- Nightly cron **enqueues one message per active user** on a new `pattern-engine` queue. The consumer loads that user's rows, runs the engine, writes results. Drop the "50ms budget per user" approach from T4.2.
- Measured in Node 22 (Workers will be similar or slower): ~60ms at 40 trips, ~135ms at 150 trips, ~210ms at 300 trips across 6 families. Set `limits.cpu_ms` on the consumer Worker with headroom (start at 5,000) and log p95 CPU per run.
- Loader SQL: completed trips only (`ended_at IS NOT NULL AND planned = 0 AND deleted_at IS NULL`), their trip-hour `conditions` rows (`catch_id IS NULL`), catches, lures, sessions, pauses, the user's `pattern_findings.record_json` as `previousRecords`, and active hypotheses. Map `hour_bucket` → `start = hour_bucket*3600000`, `end = start + 3600000`.
- Writer: `toPersisted(result)`; upsert one `pattern_findings` row per `result.records` entry (attach the matching `Finding` or NULL); update `hypotheses.result_json`; upsert `pattern_runs`. Single D1 batch.
- Post-trip: when a trip ends and enrichment completes, enqueue that user with `{ tripId }`. After the run, call `summarizeTrip(history, result, tripId)` and store it on the trip (`trips.lesson_json`, add column) for the trip-detail screen.
- First-pattern push fires on the first record reaching `emerging`, `repeated`, or `confirmed` (not `hypothesis`).
- Briefing (T5.1): the endpoint loads the same history plus the latest `pattern_runs`/findings, then calls `buildBriefing`. It is cheap enough to run on request.

## 6. UI contract (feed, cards, paywall)

- **Feed order:** lifecycle `confirmed` → `repeated` → `emerging` → `hypothesis`; within those, tier then |multiplier|. `weakening` in a "Changing" section; `retired` only in history.
- **Card:** `finding.summary` with tokens resolved (`{{offering:id}}` → lure name, `{{water:id}}`, `{{species:slug}}`). Chip: multiplier. Footer: catches / hours / trips. Badge: lifecycle label. Never display a multiplier for zero-catch findings; the summary already says "No fish in …".
- **"Why does WaterLog think this?"** sheet: `stats.trips` (supporting = catches > expected, contrary = catches < expected), `checks[]` with pass/fail icons, `confounders[]` rendered as "Overlaps with …", `aliases`, `stats.qualityHours`, `testsInFamily`, `stats.strataLevel` ("compared within same water & season" / "within same season" / "against all your fishing").
- **What changed:** `record.history` newest first; map reason codes (`new_trips:N`, `earlier_logs_edited`, `engine_updated`, `tier:a->b`, `effect_changed`, `prospective_passed`, `prospective_failed`, `recent_decline`, `below_threshold`, `revived`, `direction_reversed`, `evidence_softened`, `discovered`) to plain sentences in the client.
- **Paywall (true tease):** free users see the real count of records in `emerging | repeated | confirmed` and blurred cards. `hypothesis`-state findings are shown to Pro as "Early signal" and are never counted in the tease.
- **Empty state:** replace "7 of ~20 catches" with the top `experiments[]` and `dataQuality` ("62% of your lure time is measured"). No promised trip counts.
- Brand: one accent per surface; chartreuse only on navy; `weakening` uses dawn, `confirmed` uses tide.

## 7. Migration from v1 and parity gate

1. Add `packages/pattern-engine` to the workspace. Do not delete `packages/patterns`; v2 does not import it. Replace v2's local `timeBlock` sunrise fallback with a call into `astro.ts` only if the two disagree in tests.
2. Adapter `v2ToPatternCache(result)`: for each `Finding` with `tier !== null`, write `scope, dimension, bucket, catches=stats.catches, hours=stats.hours, rate=catches/hours, baseline_rate=stats.expected/stats.hours, multiplier=stats.multiplier, confidence=tier`.
3. Parity harness script over the seed data and the founder's real log: run v1 and v2, print both card lists side by side. **Expected differences** (not bugs): v2 multipliers are smaller (shrinkage + comparison against alternatives in the same water/season instead of the global baseline); fewer "promising" cards on thin data; zero-catch negatives appear; aliased lure/color duplicates collapse.
4. Gate: founder reviews both lists; any v1 card missing in v2 gets a written reason from the receipt (shrinkage, confounder, leave-one-out, BH) or becomes a failing test.

## 8. Spec deltas to record as ADR-0016

Write `docs/adr/0016-pattern-engine-v2.md` covering these, since they change §8 of the Startup Packet:

- Multiplier is a **Mantel–Haenszel rate ratio vs comparable alternatives within the same water × season** (broadening to season-only, then none, disclosed per finding), not bucket rate ÷ global baseline.
- Displayed multiplier is **shrunk** (normal prior on log RR, sd = ln2/1.96). Effect threshold is symmetric on the shrunk value: ≥ 1.4 or ≤ 1/1.4 (was ≥ 1.5 / ≤ 0.5 raw).
- Tiers now require credibility, not just counts: promising = CI excludes 1, BH q ≤ 0.10, evidence quality ≥ 0.5; solid additionally q ≤ 0.05, ≥ 5 exposed trips, ≥ 3 distinct weeks, quality ≥ 0.7, survives leave-best-trip-out; any competing explanation caps at early.
- "Distinct trips" means **exposed trips**, not catching trips.
- Negatives may surface with < 3 catches when expected catches ≥ 4 and the exact Poisson upper bound is below 1.
- Uncertainty uses trip-level Pearson dispersion (quasi-Poisson), not Wilson intervals (Wilson is for proportions).
- Combo rule (beat best parent by 25%) is kept, applied on the log scale to shrunk values; specific-lure findings must also beat their family and color.
- Species and bigger-fish outcome families run across all waters only (CPU bound).
- F17 decay: exact conditional binomial on season-matched windows with expected-count offsets and dispersion-scaled counts, **plus** a winner's-curse guard (the recent window must also fail the effect threshold). Without the guard, every freshly discovered pattern "decays" because its discovery window is selection-inflated — caught in testing.
- Supersedes ADR-0015 for trips with tie-on logs; apportioned exposure remains as a fallback, scored 0.4 quality so it can never reach solid alone.

## 9. Acceptance criteria

- [ ] `pnpm --filter @waterlog/pattern-engine test` green (45 existing tests) and typecheck clean under repo tsconfig.
- [ ] **Branch coverage to 100%** (currently 99.6% lines / 91.4% branches). Known uncovered branches: `analyze.ts` 51, 118, 211, 233, 235, 259, 320, 338, 346 · `briefing.ts` 231 · `dimensions.ts` 66–78, 121, 137 · `engine.ts` 23, 58 · `exposure.ts` 38, 68, 90, 114, 149, 191, 224 · `family.ts` 174–176 · `hypotheses.ts` 35, 61, 141 · `lifecycle.ts` 154, 169 · `persist.ts` 7 · `special.ts` 49–51, 91, 98–107 · `distributions.ts` 58–59. Unreachable branches get removed, not ignored.
- [ ] Property test retained: shuffling every input array produces byte-identical JSON.
- [ ] Noise test retained: 12 synthetic null users → 0 solid, ≤ 6 promising.
- [ ] Migration applies clean on a fresh D1 and on a copy of dev.
- [ ] Seed data extended: one trip with pauses, one with tie-on sessions and a mid-trip switch, one targeting another species, one zero-catch trip with sessions. Existing zero-catch and lure-variety seeds kept.
- [ ] Enrichment boundary tests for the four new condition columns.
- [ ] Queue consumer logs CPU ms per user; p95 recorded against the founder's real data.
- [ ] Parity harness output reviewed and ADR-0016 merged before the feed UI switches from `pattern_cache` to `pattern_findings`.

## 10. Build order

1. ADR-0016 + migration + Zod schemas.
2. Package into the workspace, coverage to 100%.
3. Capture: tie-on chip, pause, target chip (ships value immediately as data quality).
4. Enrichment columns + backfill.
5. Queue consumer + writer + adapter to `pattern_cache`.
6. Parity gate.
7. Feed on `pattern_findings`: lifecycle badges, receipt sheet, what-changed.
8. Hypothesis notebook entry (structured picker: dimension → bucket → expectation; free-text statement for display).
9. Briefing on v2, then post-trip lesson.
