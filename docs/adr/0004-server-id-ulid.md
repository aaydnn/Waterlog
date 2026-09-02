# ADR-0004: Server-assigned ids use ULID, except `users.id`

Status: accepted
Date: 2026-09-02

## Context

`docs/waterlog-startup-packet.md` §07 specifies "TEXT ULIDs as PKs" as the primary-key convention
for every table. The current implementation predates that packet being committed to the repo:
`workers/api/src/lib/users.ts` generates `users.id` with `crypto.randomUUID()`, and that code is
already deployed with live rows using that format.

Epic 1's sync route (ADR-0003) is the first place `trips.id` and `catches.id` are actually
generated server-side, so this is the last point before the divergence would need a data
migration to fix.

## Decision

New server-assigned primary keys (`trips.id`, `catches.id`, and every table after this ADR) are
generated with the `ulid` npm package, not `crypto.randomUUID()`. `users.id` keeps its existing
UUID format — it is not retrofitted. `sessions.id` and `login_tokens.id` are unaffected; they are
derived as `sha256(token)`, not a randomly generated primary key, so they were never part of this
convention to begin with.

Client-generated `client_id` values (the sync idempotency key on `trips` and `catches`) were
already specified as ULIDs and are unaffected by this ADR.

## Consequences

- `users.id` remains the one UUID-format primary key in the schema; every other table's `id` is a
  ULID. This is a documented, intentional exception, not drift.
- ULIDs are lexicographically sortable by creation time, which is a small but genuine benefit for
  a time-series-heavy app (trips and catches are naturally queried in chronological order).
- `workers/api/src/lib/ids.ts` centralizes ULID generation so future tables have one obvious
  function to call.
