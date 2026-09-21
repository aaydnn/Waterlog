# ADR-0013: The server closes a forgotten trip at the ceiling, not at six hours idle

Status: accepted
Date: 2026-09-15

## Context

Packet §04 F2 says a trip auto-closes "after 6h idle or >20km GPS drift". The client implements
that rule as a prompt: `apps/web/src/features/trips/auto-close.ts` decides when to ask, the trip
banner asks, and "Still fishing" snoozes it for six more hours. Nothing on the server ever closes
anything.

Epic 4 makes that gap expensive. Every rate in packet §08 divides by hours on water, and an open
trip has no `ended_at`, so it generates no hour buckets and contributes no exposure — while its
catches still count wherever they are counted. A trip left open is a numerator with no
denominator. Worse, when someone finally taps "End trip" on a trip from last Tuesday, the client
sends `Date.now()` and ADR-0012's clamp records forty-eight hours of fishing that never happened,
all of it landing in the denominator at once.

The obvious fix is to run F2's six-hour rule on the server. It is also wrong.

Six hours of nothing is exactly what a hard skunk looks like. A trip where the angler fishes dawn
to dusk and catches nothing has its last activity at its own start, so a six-hour server sweep
would close it at `started_at + 1h` while they are still standing in the water. That cuts a real
ten-hour skunk to one hour and removes nine hours of the hardest-won exposure data this product
collects. The error runs in the direction that flatters the angler's catch rate, which is the
direction the pattern engine must never be wrong in.

The client can afford the six-hour rule because it can ask. The server cannot ask.

## Decision

Two rules, split by who can answer the question.

**Idle and drift stay on the client**, unchanged, as a prompt with a snooze. That is F2 as
written, and the angler is the only party who knows whether the trip is over.

**The server closes only what cannot still be real.** `autoCloseStaleTrips` closes trips still
open past `MAX_TRIP_DURATION_MS` (48h). Every path that can close a trip already clamps it to that
ceiling (ADR-0012), so a trip open beyond it cannot legitimately accrue another minute — there is
no ambiguity left to resolve and nothing real to lose.

The recorded end is `max(started_at + 1h, last catch)`, clamped to the ceiling. This is the same
answer the client's `suggestedEndAt` gives, deliberately: whichever side closes a forgotten trip,
it gets recorded the same length. The one-hour floor matches `upsertOrphanTrip` and exists so a
skunk is never recorded as zero hours, which would delete it from the denominator.

The sweep runs on `POST /api/sync`, before the batch's own trips are written, scoped to the
requesting angler. Sync is where activity is reported, so it is where staleness is discoverable.
It is idempotent — `endTrip` only touches a trip that is still open — and the trips it closes are
not returned in the response: the client mirrors `trips` by `client_id` and would file a trip it
never enqueued as a second local row, leaving the original still looking active.

## Consequences

- A trip nobody closed stops being invisible to the pattern engine. It contributes its real hours,
  ending where the evidence ends.
- A trip left open by an angler who then stops using the app stays open until they next sync. They
  are not fishing, so the engine loses nothing by waiting.
- The cron worker does not sweep. It has no queue binding and would need a second copy of this
  rule; sync covers the case that matters, and the pattern engine excludes open trips from both
  numerator and denominator in the meantime.
- GPS-drift auto-close remains client-only and unbuilt as an automatic close. It is the half of F2
  that genuinely needs a position fix, and it stays a prompt.
- Two sync tests moved from asserting a total queue-send count to asserting the count of `catch`
  jobs. Their fixture trip is open and months old, so a replay is also the first sweep that sees
  it — the extra send is the sweep working, not a regression.
