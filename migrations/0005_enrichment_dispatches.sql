-- Record successful queue sends so HTTP retries recover interrupted dispatches.
-- A crash between send and receipt can redeliver: conditions upserts are idempotent.
CREATE TABLE enrichment_dispatches (
  job_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
