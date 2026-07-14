CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- sha256 of the token; raw token only in the cookie
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE login_tokens (         -- magic link tokens, single-use
  id TEXT PRIMARY KEY,              -- sha256 of token
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,      -- 10 minutes
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
