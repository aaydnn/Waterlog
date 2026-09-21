-- Pattern engine v2 (ADR-0017): measured exposure, stratified comparison, and findings that carry
-- their own lifecycle between runs.
--
-- Three groups of change here:
--   1. Capture tables that make exposure measured rather than apportioned (ADR-0015 -> ADR-0017).
--   2. Four nullable enrichment columns for condition trajectory and real sunset.
--   3. Persistence for the v2 engine: findings, hypotheses, and the run-level result blob.
--
-- `pattern_cache` is deliberately untouched. The v2 queue consumer writes into it through the
-- `v2ToPatternCache` adapter so the shipped feed keeps working until the parity gate passes.

-- ---------------------------------------------------------------------------------------------
-- 1. Measured exposure
-- ---------------------------------------------------------------------------------------------

-- Tie-on intervals: what was actually in the water, and when. This is the "change lure" tap that
-- ADR-0015 named as the condition for its own deletion — with these rows, lure exposure stops
-- being a trip's hours shared out among whatever happened to catch, and becomes a measurement.
--
-- `end_at` NULL means the session runs until the next tie-on on the same trip, or the trip's end.
-- The engine closes it; the client never has to, because a client that has to remember to close
-- an interval will eventually ship one that never closes.
--
-- `source` distinguishes a tap the angler made from an interval the engine estimated, and the
-- estimated ones are scored down as evidence (ADR-0017: apportioned exposure caps at 0.4 quality
-- and so can never reach `solid` on its own).
--
-- Note: this table does not already exist. The brief flagged it as possibly landed by F14; F14
-- never shipped it, so there is nothing to reconcile and it is created outright here.
CREATE TABLE offering_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  lure_id TEXT NOT NULL REFERENCES lures(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  source TEXT NOT NULL DEFAULT 'tap',           -- tap | estimated
  -- Client-generated ULID, the dedupe key for sync: replaying a batch twice must create zero
  -- duplicate sessions, same contract as trips and catches.
  client_id TEXT UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

-- The loader reads one trip's sessions in start order to walk the intervals.
CREATE INDEX idx_offering_sessions_trip ON offering_sessions(trip_id, start_at);

-- Non-fishing time inside a trip: the drive between spots, lunch, the hour spent re-rigging.
-- Without it a trip's exposure is wall-clock, which quietly dilutes every rate measured on the
-- trips where the angler took a break — and those are disproportionately the long trips.
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

-- The three `trips` columns this section used to add (`effort_source`, `target_species`,
-- `lesson_json`) moved to 0009_trip_effort_capture.sql, which ships with the API and client code
-- that already writes them.

-- ---------------------------------------------------------------------------------------------
-- 2. Enrichment: trajectory and real sunset
-- ---------------------------------------------------------------------------------------------
-- All four are nullable and best-effort. A condition row with none of them is still a valid
-- exposure row — the engine treats a missing trajectory as an unmeasured dimension, not a zero.

-- Negative = after sunset, matching the existing `minutes_from_sunrise` convention.
ALTER TABLE conditions ADD COLUMN minutes_to_sunset INTEGER;

-- Water temperature now minus 72h earlier at the matched gauge. NULL without gauge coverage:
-- air temperature is not a substitute, because the thing that moves fish is the water.
ALTER TABLE conditions ADD COLUMN water_temp_delta_72h_c REAL;

-- Rain in the 48h before this hour. The runoff an angler is fishing today fell yesterday.
ALTER TABLE conditions ADD COLUMN precip_prev_48h_mm REAL;

-- Discharge change over 24h, as a percentage. NULL if either reading is missing, or if the prior
-- discharge is 0 — a percentage change off zero is a division, not a measurement.
ALTER TABLE conditions ADD COLUMN discharge_delta_24h_pct REAL;

-- ---------------------------------------------------------------------------------------------
-- 3. v2 persistence
-- ---------------------------------------------------------------------------------------------

-- One row per finding per user, holding that finding's latest state.
--
-- Two JSON columns, and the difference between them is the point of the table. `finding_json` is
-- what the feed shows *this* run, and is NULL when the finding exists but is not currently
-- surfaced. `record_json` is the lifecycle state that survives between runs: when it was
-- discovered, what it has done since, what changed the engine's mind. Losing `record_json` would
-- reset every angler's history to "discovered today", so it is NOT NULL and always written.
CREATE TABLE pattern_findings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,                             -- scope::outcome::dimension::bucket
  scope TEXT NOT NULL, outcome TEXT NOT NULL,
  dimension TEXT NOT NULL, bucket TEXT NOT NULL,
  direction TEXT NOT NULL,                       -- positive | negative
  tier TEXT,                                     -- early | promising | solid | NULL (not surfaced)
  lifecycle TEXT NOT NULL,                       -- hypothesis | emerging | repeated | confirmed |
                                                 -- weakening | retired
  multiplier REAL NOT NULL,                      -- shrunk (ADR-0017)
  finding_json TEXT,                             -- Finding, NULL when not surfaced this run
  record_json TEXT NOT NULL,                     -- FindingRecord, carried between runs
  engine_version TEXT NOT NULL,                  -- tells "engine changed" from "fishing changed"
  computed_at INTEGER NOT NULL,
  -- Keyed by (user, finding) rather than a synthetic id so the nightly writer is a plain upsert
  -- and a redelivered queue message cannot fork a finding's history into two rows.
  PRIMARY KEY (user_id, key)
);

-- The feed orders by lifecycle then tier; the free-tier tease counts the emerging/repeated/
-- confirmed rows in SQL rather than from the returned page (ADR-0016).
CREATE INDEX idx_findings_feed ON pattern_findings(user_id, lifecycle, tier);

-- The angler's own beliefs, tested against their own data. `statement` is their words and is
-- display-only; the engine reads the structured columns. Kept separate from `pattern_findings`
-- because a hypothesis is a standing question, not a discovered claim — it stays on the list
-- while it is still unanswered, which is the whole value of writing it down.
CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  statement TEXT NOT NULL,
  dimension TEXT NOT NULL, bucket TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all', outcome TEXT NOT NULL DEFAULT 'all',
  expectation TEXT NOT NULL,                     -- better | worse | no_difference
  result_json TEXT,                              -- latest HypothesisResult
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE INDEX idx_hypotheses_user ON hypotheses(user_id, deleted_at);

-- Run-level output that is not a finding: family metadata, profiles, experiments, questions, and
-- data quality. One row per user, replaced each run.
--
-- `pattern_runs` already exists (migration 0008), keyed by user_id, so these are added to it
-- rather than declared fresh — a second CREATE TABLE of the same name fails outright on a fresh
-- D1, which would break the "applies clean" requirement.
--
-- They are nullable despite being required in practice: SQLite cannot add a NOT NULL column to a
-- table that already has rows without a default, and there is no honest default for a run result.
-- NULL here means "this user has not been through the v2 engine yet", which is exactly true for
-- every row 0008 left behind.
ALTER TABLE pattern_runs ADD COLUMN result_json TEXT;
ALTER TABLE pattern_runs ADD COLUMN engine_version TEXT;
ALTER TABLE pattern_runs ADD COLUMN computed_at INTEGER;

-- 0008's `cursor` column is now vestigial: v2 enqueues one message per user and runs that user to
-- completion, so there is no partial run to resume (ADR-0017 supersedes the T4.2 50ms budget).
-- It is left in place rather than dropped — migrations here are append-only, and a dropped column
-- is the one change that cannot be walked back.
