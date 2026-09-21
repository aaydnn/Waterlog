# Epic 4 — Pattern Engine: acceptance

Packet §10 criteria: **100% branch coverage; shuffle-invariance property test; 50ms budget per
user or re-queue; free user sees true count, blurred cards.**

## The four criteria

### 100% branch coverage in `packages/patterns`

`@vitest/coverage-v8` runs as part of `pnpm test`, with thresholds of 100 for branches,
statements, functions and lines. It is a gate, not a report: a new uncovered branch fails CI.

| File | Branches |
| --- | --- |
| buckets.ts | 100% |
| compute.ts | 100% |
| confidence.ts | 100% |
| describe.ts | 100% |

Two branches that could not be reached were removed rather than excused. The combo parent lookup
was a defensive `undefined` check that is unreachable by construction — a combo's buckets are a
subset of each parent dimension's own buckets — and now uses a non-null assertion with the reason
written next to it. `describePattern` no longer pads a missing bucket with an empty string; it
renders the parts that line up, which is both testable and the better failure.

### Shuffle invariance

`src/shuffle.test.ts` generates whole angler histories with `fast-check` — six trips, arbitrary
conditions with nulls throughout, arbitrary lures including missing ones — shuffles both the hours
and the catches, and asserts the serialized output is identical. 300 runs per invocation, plus 200
more asserting no multiplier is ever non-finite.

The engine is built so this is true rather than tested until it passes: bucket keys are sorted
before use, offerings are sorted before a trip's hours are shared out, exposure is tallied as
integer counts per denominator and summed in denominator order rather than accumulated as floats,
and the output is sorted canonically by scope, dimension and bucket.

### The per-user budget

Packet §10 asks for "50ms budget per user or re-queue". **Implemented as a row budget, not a
timer**, and this is a deliberate deviation.

Inside a Worker, `Date.now()` and `performance.now()` advance only across I/O. The engine is pure
CPU, so a timer-based budget observes no time passing and would never fire. The budget is measured
in the work itself: rows fed through the engine, defaulting to 60,000, cutting at a scope boundary.
It is deterministic, it cuts in the same place every time, and it is testable — which a clock in a
shared runtime is not.

Proven in `workers/cron/test/recompute.test.ts`:

- a run that exceeds the budget stops, records its cursor, and reports `completed: false`
- the follow-up message resumes at the cursor rather than restarting
- a feed built over five chunked messages is row-for-row identical to one built in a single pass
- an unknown cursor restarts the angler instead of skipping the rest of their waters
- a redelivered message writes no duplicates

### The paywall

`workers/api/test/patterns.test.ts` asserts against the **raw response text**, not the parsed
object, that a free angler's payload contains no bucket name, no multiplier, no catch count, no
hour count and none of the field names that would carry them. The free tier gets the true total —
counted in SQL, not taken from the page, which stops at sixty — plus a per-card confidence tier and
a label naming the kind of thing the pattern is about.

The client renders placeholders from that, so there is nothing in the DOM to un-blur either. A web
test asserts the same absence in the rendered output.

## What the engine computes, reconciled

`workers/cron/test/recompute.test.ts` drives the real queries against a real D1 through
`vitest-pool-workers` over a known fixture: six trips of four hours, one hour of falling pressure
each with two fish, the rest stable with one.

| Figure | `pattern_cache` | Raw SQL |
| --- | --- | --- |
| falling-pressure hours | 6 | `COUNT(*) WHERE pressure_trend = 'falling'` = 6 |
| falling-pressure catches | 12 | 2 per trip × 6 trips = 12 |
| baseline rate | 0.75 | `total_catches / total_hours` = 18/24 |
| multiplier | 2.667 | `rate / baseline_rate` |

Same fixture family covers a per-water scope, an angler under the ten-hour baseline getting
nothing, a rerun replacing rather than doubling, a stale water's rows being pruned, and an open
trip's catches being reported as unattributed rather than silently dropped.

## Deviations, each with an ADR

- **ADR-0013** — the server closes a forgotten trip at the 48h ceiling, not at six hours idle.
  Six hours of nothing is what a hard skunk looks like; closing that trip mid-outing would cut a
  real ten-hour skunk to one hour and corrupt the denominator in the direction that flatters the
  angler. The six-hour rule stays on the client, where it can ask.
- **ADR-0014** — both sides of every rate are read from the trip-hour row, and a catch is clamped
  into the range its own trip covers.
- **ADR-0015** — lure exposure is apportioned per trip and carries its own baseline, because
  nothing records what was tied on during an hour that produced nothing.
- **ADR-0016** — the free tier is redacted on the server.

## Packet ambiguities resolved

- **Which tier triggers the first-pattern push.** §08's table says `solid`; §09 flow 3 says "first
  promising+ pattern". Implemented as promising-or-better, following the flow spec that describes
  the push itself. The card says "Promising" on its face, so nothing is oversold.
- **Sky bands.** §08 names clear / partly / overcast without cuts. Uses the standard
  meteorological ones: under 25% cloud, 25–75%, 75% and over.
- **Dusk.** §08 defines every time block relative to sunrise, and `conditions` stores no sunset
  offset, so dusk is anchored at 12.5 hours after sunrise. Right within the hour across
  mid-latitudes, and drifting in high-latitude midsummer. A `minutes_from_sunset` column would make
  it exact; it is a candidate for later rather than a guess dressed up as a measurement.

## Trying it locally

The main dev seed produces nothing, correctly: it writes no `conditions` rows, so there are no
exposure hours to divide by. `migrations/seed/patterns-seed.sql` writes the trip-hours directly
(no network, no enrich worker) and its header lists the exact cards it should produce. The recipe,
including the shared `--persist-to` that lets the cron worker see what the API worker seeded, is
in CLAUDE.md under Develop.

Running it end to end is what caught the missing `trips` column: the engine counted distinct trips,
the tiers used the count, and nothing persisted it, so every card footer read "undefined trips".
Migration 0008 adds the column and both worker suites now assert it survives the round trip.

## Manual steps before this deploys

1. **Create the queue.** `wrangler queues create waterlog-patterns` — the cron worker is both its
   producer and its consumer, and `wrangler deploy` will not create it.
2. **Generate a VAPID keypair** and set it as secrets on the cron worker:
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:`). Set the same public key
   on the API worker as `VAPID_PUBLIC_KEY`, which is what `GET /api/push/key` hands to browsers.
   Without them the recompute still runs, the push is skipped, and the once-ever flag stays
   unclaimed so the announcement survives until the keys are configured.
3. **Apply migration 0008** — CI does this on merge to `main`.

## Known gaps entering Epic 5

- **The Unlock Pro button does nothing yet.** Stripe checkout is Epic 5. The button is rendered
  because the paywall's empty state is the free-to-Pro narrative and shipping it without the
  call to action would be shipping half of it.
- **GPS-drift auto-close** is still a client prompt only, the other half of §04 F2.
- **The first-pattern push has never been sent to a real device.** The VAPID token is verified
  against its own public key in a test and the `aes128gcm` body is asserted byte-for-byte, but no
  real push service has accepted one. That needs a deployed environment with keys set.
- **Real-water validation still pending** — one real catch, one real skunked trip, end to end. The
  same open item Epics 2 and 3 carry.
- **`hours_until_baseline` counts hours, not catches.** The progress meter says "7 of ~20 catches
  until patterns emerge" in the packet; this implementation counts down to the ten-hour baseline
  first and then switches to a catch-count message without a live number. Wiring the real catch
  count into it is a small follow-up.
