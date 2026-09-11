# ADR-0012: Bounded sync input and a 48-hour trip ceiling

Status: accepted
Date: 2026-09-10

## Context

Packet §07 makes the trip-hour `conditions` row the denominator for every rate the pattern engine
computes: **every hour of every trip gets a row**. That is the right data model and it is also, on
the write path, a multiplier the client controls. `computeHourBuckets` allocated one bucket per
trip hour with no ceiling, and each bucket costs the enrich worker a weather lookup, a gauge
lookup and a D1 upsert.

Nothing validated the timestamps that feed it. A trip whose `started_at` was a year back and whose
`ended_at` was now produced 8,760 enrichment hours from one request — the same 8,760 whether it
arrived through `POST /api/sync` or through `PATCH /api/trips/:id/end` on a trip nobody closed.
`POST /api/sync` compounded it: the `trips` and `catches` arrays had no length cap and the body no
size cap, so a single request could ask for an unbounded number of writes and outbound fetches.

The packet states no maximum for either. §04 F2 is the closest thing — a trip auto-closes "after
6h idle or >20km GPS drift" — but that is a client-side prompt, not a server rule, and the server
must not depend on the client having run it.

## Decision

Bound the input at the edge, before anything is persisted or allocated.

**Impossible timestamps are rejected.** `validateTripTimes` (in `workers/api/src/lib/trips.ts`,
shared by the sync batch and the end-trip route) refuses a non-finite value, anything before
2000-01-01, anything more than 24 hours ahead of server time, and an `ended_at` before its own
`started_at`. These are bugs, not data: there is nothing to preserve. The 24h future skew keeps a
device with a wrong clock syncing rather than silently losing catches. In sync this is a per-item
`errors` entry — the rest of the batch still lands — and on the trips route a 400.

**A trip is at most 48 hours, by clamping — not by rejecting.** `clampTripEnd` cuts an over-long
`ended_at` back to `started_at + 48h`, and the clamped value is what is persisted and returned, so
the client mirrors it. 48h is double a genuine overnight outing and 8× F2's idle auto-close.

Length is the one rule that must not reject, because unlike a malformed timestamp it fires on
ordinary use and the client has no way to recover. The manual "End trip" button sends
`Date.now()`: an angler who forgot to close Tuesday's trip and taps it on Thursday would get a
400, the queued end would retry forever, and the trip would never close. In a batch it is worse —
a rejected trip takes every catch that references it by `client_id` down with it
("trip_id not found"), stranding those catches with nothing to correct. A trip nobody closed was
never 48 hours of fishing, so cutting it at the ceiling is both the honest record and the bounded
one.

**`computeHourBuckets` clamps rather than throws**, at `MAX_TRIP_HOUR_BUCKETS = 48` — a backstop
for rows written before any of this existed, which still flow through the enqueue path.
Enrichment is best-effort (packet §06), so bounding the work is the correct failure there, where
a thrown error would 500 a request whose rows are already committed. Normal trips are untouched —
4.5h still yields exactly 5 buckets (packet §10).

**A sync batch is at most 200 trips, 500 catches, and 1 MiB.** Sized to the worst honest case, a
season's backlog flushed after months offline, with an order of magnitude spare: 200 trips is more
outings than the heaviest persona fishes in a year (§03: 8–20 days/yr) and 500 catches is about
1.4 hours of continuous 10-second captures. Over the row caps is a 400; over the byte cap a 413,
measured from `content-length` and from the raw text before it is parsed.

**Per account, enrichment dispatches are capped at 1,000 per rolling 24 hours**, counted from the
existing `enrichment_dispatches` table. Over budget the send is skipped, not failed: capture is
never blocked, and because no receipt row is written the job re-dispatches on a later sync once
the window rolls off.

## Consequences

- The worst single request now costs 200 × 48 + 500 ≈ 10,100 enrichment units instead of an
  unbounded number, and one trip costs 48 hours instead of 8,760.
- A trip left open for more than 48 hours closes at `started_at + 48h`, not at the moment the
  angler noticed. The recorded hours-on-water for that trip is then a bound, not a measurement.
  That is the trade: an approximate closed trip beats an exact open one that no client can close,
  and the trip-hour denominators stay finite either way. The auto-close prompt (which suggests
  the last activity rather than the current clock) keeps this rare.
- The per-account cap counts *jobs*, not *hours*: 1,000 dispatches could still be 1,000 × 48
  bucket-hours. Counting the real unit needs an `hour_buckets INTEGER` column on
  `enrichment_dispatches` (plus an index on `(user_id, created_at)`, which that count query wants
  regardless). Both are one migration, deliberately not taken here.
- Related contract, same security pass: `POST /api/sync` and `PATCH /api/trips/:id/end` accept an
  optional `X-Waterlog-User` header naming the account the client queued its rows for, and answer
  `409 {"error":"session_mismatch"}` before any write when it disagrees with the session. Absent,
  the request proceeds as before, so clients deployed before the header existed keep working.
