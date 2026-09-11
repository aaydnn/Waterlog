-- Application-level abuse controls for unauthenticated endpoints (POST /api/auth/magic-link).
-- A fixed-window counter per bucket key. `bucket` is an opaque, caller-composed string —
-- 'magic-link:ip:<ip>' or 'magic-link:email:<sha256 of the normalised address>' — so the raw
-- address never lands in this table (login_tokens already holds it; this one need not).
--
-- Deliberately D1 and not Cloudflare's rate-limit binding: the binding has no local/test
-- implementation, and the limiter has to be exercised by the existing Miniflare harness.
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,  -- epoch ms the current window opened
  expires_at INTEGER NOT NULL     -- window_start + window length; row is dead after this
);

-- Supports the opportunistic sweep of dead windows, so the table cannot grow without bound.
CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at);

-- Expired magic-link tokens are swept the same way (see lib/magic-link.ts); the sweep filters
-- on expires_at, which had no index.
CREATE INDEX idx_login_tokens_expires ON login_tokens(expires_at);

-- The per-address cap invalidates a user's older unconsumed tokens when a new one is minted,
-- which filters on (email, consumed_at).
CREATE INDEX idx_login_tokens_email_live ON login_tokens(email) WHERE consumed_at IS NULL;
