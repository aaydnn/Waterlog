-- Epic 4: what the nightly pattern recompute needs to run in chunks, and what the first-pattern
-- push needs to reach a phone.

-- One row per angler the engine has worked on. The cron worker enqueues a job per user and the
-- queue consumer computes one user per message, so this is where a run that ran out of CPU says
-- where it got to: `cursor` is the scope it was working on when the budget ran out, and a resumed
-- run picks up from there rather than starting the season again.
CREATE TABLE pattern_runs (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  -- Epoch ms of the last run that finished the whole angler, so a nightly pass can skip anyone
  -- already done today and a redelivered message is cheap rather than duplicated work.
  completed_at INTEGER,
  -- Scope the next chunk resumes at; NULL means start from the beginning.
  cursor TEXT,
  -- Diagnostics, written every run: enough to tell a thin feed from a broken one without
  -- re-running the engine.
  pattern_count INTEGER NOT NULL DEFAULT 0,
  unattributed_catches INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- The nightly sweep selects anglers whose last completed run is older than the cutoff.
CREATE INDEX idx_pattern_runs_completed ON pattern_runs(completed_at);

-- Distinct trips contributing catches to a pattern. Packet §07's pattern_cache predates §08's
-- confidence tiers and has no column for it, but it is the number those tiers are actually built
-- on: eleven fish in one session is one observation, not eleven, and requiring distinct trips is
-- the only thing standing between a pattern and one lucky evening. It is also what the card's
-- sample-size footer shows, so without it the footer cannot be written.
ALTER TABLE pattern_cache ADD COLUMN trips INTEGER NOT NULL DEFAULT 0;

-- Web Push (VAPID) subscriptions: one per browser that opted in. The endpoint is the address the
-- push service issued and is unique by construction, which also makes re-subscribing idempotent —
-- a browser that re-registers the same endpoint must not accumulate rows.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

-- Packet §09 flow 3: the first promising-or-better pattern is the retention moment, and it only
-- happens once. Stamped in the same batch that writes the patterns, so a queue retry cannot send
-- the same announcement twice.
ALTER TABLE users ADD COLUMN first_pattern_notified_at INTEGER;

-- The pattern feed reads one angler's rows for one scope, newest run first. The existing
-- idx_pattern_user_scope covers (user_id, scope, multiplier); this one lets the writer delete a
-- user's previous rows for a scope without scanning the table.
CREATE INDEX idx_pattern_cache_user_dimension ON pattern_cache(user_id, scope, dimension);
