# ADR-0003: Add `client_id` to `trips` for sync idempotency

Status: accepted
Date: 2026-09-01

## Context

Epic 1's sync endpoint must satisfy "replaying a sync batch twice creates zero
duplicates" for both trips and catches. `catches` already has a
`client_id TEXT UNIQUE` column for exactly this purpose (client generates it
offline, server dedupes creation on it). `trips` (migration 0001) has no such
column.

The alternative considered was letting the client dictate a trip's `id`
directly (client generates the primary key itself, server does
`INSERT ... ON CONFLICT(id) DO NOTHING`). This was rejected: every other
server-assigned `id` in this codebase (`users.id`, `catches.id`) is generated
server-side via `crypto.randomUUID()`, and letting trips alone break that
pattern means the sync route has to defend against a client-supplied `id`
colliding with another user's existing row — extra bespoke logic that a
separate dedupe key doesn't need.

## Decision

Add a nullable `client_id TEXT` column to `trips` with a `UNIQUE` index,
identical in shape to `catches.client_id`. The sync route upserts trips the
same way it upserts catches: `INSERT ... ON CONFLICT(client_id) DO NOTHING`
(server assigns `id`), then `SELECT` the canonical row. Ending a trip is a
separate, narrow `UPDATE trips SET ended_at = ? WHERE id = ? AND ended_at IS
NULL` — idempotent by construction, and kept distinct from creation so a
replayed sync can never blindly overwrite fields with a stale client copy.

## Consequences

- One additional nullable column beyond the Epic 0 schema transcribed
  verbatim from the spec. SQLite permits multiple `NULL`s under a `UNIQUE`
  index, so existing seed rows (which have no `client_id`) are unaffected.
- Trip creation and catch creation now share one idempotency idiom
  end-to-end, rather than two different ones.
