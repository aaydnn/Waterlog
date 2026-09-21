# WaterLog Epic 4 — Pattern Engine: implementation plan

> **Built and merged.** Kept as the record of what was decided before the code existed. Two things
> changed once the code was real, both noted inline below: the stale-trip backstop moved from a
> six-hour idle rule to the 48-hour ceiling (ADR-0013), and the ADRs renumbered to 0013-0016. The
> evidence for what shipped is in `docs/epic-4-acceptance.md`.

**Packet scope (§10):** `packages/patterns` core per §08; nightly cron chunked to Worker CPU
limits; pattern feed + blurred paywall + first-pattern push.

**Packet acceptance:** 100% branch coverage; shuffle-invariance property test; 50ms budget per
user or re-queue; free user sees true count, blurred cards.

**Today:** `packages/patterns/src/index.ts` is `export {}`. `workers/cron` logs its invocation
and returns. `pattern_cache` exists in migration 0001 and `patternCacheRowSchema` in
`packages/schema`, both unused. `apps/web/src/features/patterns` holds a `.gitkeep`, and the
bottom nav deliberately has no Patterns tab.

---

## Decisions to make before writing math

Four questions the packet does not answer. Each changes the numbers, so they are settled here
and each deviation carries an ADR committed with its code.

### D1 · What is one hour of exposure, and which hour does a catch belong to

Exposure is a `conditions` row with `trip_id` and `hour_bucket` set: one row, one hour. They are
integers, which is worth protecting — summing counts rather than durations keeps the denominator
exact and kills most float non-determinism before the shuffle test ever runs.

The numerator has to come from the same rows or the rate is a ratio of two different worlds. A
catch carries its own `conditions` row, enriched at its own timestamp, and that row can disagree
with the trip-hour row covering the same hour: different fetch, different interpolation. If
"falling" is read off the catch row and the denominator off the trip-hour rows, a bucket can
collect catches against near-zero exposure and report an enormous multiplier.

**Decision:** dimension values for both numerator and denominator are read from the trip-hour
row. A catch is attributed to the bucket
`clamp(floor(caught_at / 3600000), firstBucket, lastBucket)` over that trip's own rows. The
per-catch `conditions` row stays what the journal detail sheet shows. It is not what the engine
counts.

The clamp is load-bearing. `computeHourBuckets` emits `ceil(duration / 1h)` buckets anchored at
`floor(started_at / 1h)`, so a trip from 06:45 to 11:15 yields hours 6 through 10 and a catch at
11:05 falls outside them. Clamping keeps that catch in the last hour instead of dropping it.
Widening the bucket set instead would contradict the Epic 2 acceptance criterion that a 4.5h
trip yields exactly 5 rows, so the clamp is the cheaper correct answer. → **ADR-0014**.

### D2 · Lure dimensions have no honest denominator

`lure_family` and `lure_color` are properties of a catch. Nothing records which lure was tied on
during an hour that produced nothing, so "hours of chartreuse exposure" does not exist in the
data. The packet's own example sentence, 11 catches over 14 hours across 6 trips, quietly
assumes it does.

Dividing lure catches by *all* trip hours is the tempting shortcut and it is wrong in a way that
flatters the angler. The lure thrown ninety percent of the time scores as well as the lure
thrown once that hammered fish.

**Decision:** approximate lure exposure per trip, and never mix denominators across dimension
families.

- For each ended trip, that trip's hours are split evenly across the distinct lures that caught
  something on it. One lure takes all the hours. Three lures take a third each.
- Skunked trips contribute no lure exposure at all, because nothing indicates what was tied on.
- The lure baseline is therefore computed over catch-bearing trip hours only, while condition
  dimensions keep the full baseline over every hour. A multiplier only ever compares a bucket
  against a baseline drawn from the same denominator.

This is the biggest judgment call in the epic. It is an approximation, the card footer says so,
and it is what makes lure patterns comparable to condition patterns rather than systematically
inflated. → **ADR-0015**.

### D3 · A blurred card rendered on the client is not a paywall

"Compute for everyone; reveal behind the paywall. The tease must be true." If the server sends a
free user real card text and CSS blurs it, the payload is one devtools tab away from being the
product.

**Decision:** redaction is server-side. A free user's `GET /api/patterns` returns the true total
and, per card, only the confidence tier and the dimension's display category. Never the bucket,
the multiplier, the counts or the sentence. The client renders placeholder cards of the right
shape with the true count over them. The tease stays true and the product stays behind the
paywall. → **ADR-0016**.

### D4 · Web Push does not exist yet

`WebPushRegistrar.register()` rejects with `NotImplementedError`, and its comment defers real
registration to the briefing epic. But the first-pattern push is an Epic 4 deliverable, and Epic
5 needs the same transport.

**Decision:** build the minimum VAPID send path here. A `push_subscriptions` table, a real
registrar, an ES256 VAPID JWT signed with Web Crypto, and one send site in the cron worker. Epic
5 reuses it for briefings rather than inventing a second one. This is the largest unknown in the
epic and the task most likely to slip, so it is sequenced last and the engine ships without it
if it does.

---

## Blocker to clear first

**Trip auto-close (T1.4) is unbuilt, and Epic 4 divides by trip hours.** An open trip produces no
hour buckets, so its catches attribute to nothing. A trip someone forgot to end contributes up to
48 hours of fictional exposure the moment it closes, and every rate computed against that
baseline is wrong. Packet §04 F2 specifies auto-close after 6h idle or more than 20km of GPS
drift.

Task 0 lands the 6h idle half server-side. GPS drift needs the client and can follow in Epic 6
polish. Until then the engine excludes open trips from both numerator and denominator and
reports the excluded count, so a thin feed is explainable rather than mysterious.

> **Changed while building.** The client already implements F2's six-hour rule as a prompt with a
> "Still fishing" snooze, so the gap was only ever the server. Running the same six-hour rule
> server-side turned out to be actively wrong: six hours of nothing is exactly what a hard skunk
> looks like, and closing that trip at `started_at + 1h` while the angler is still standing in the
> water would delete nine hours of the hardest-won exposure data this product collects. The server
> now closes only trips open past the 48-hour ceiling, where nothing real can be lost. → ADR-0013.

---

## Tasks

### Task 0 · Trip auto-close on idle

Close trips idle past 6h, server-side, so hours on water stops being a function of whether
someone remembered to press stop.

- `workers/api/src/lib/trips.ts` gains `autoCloseStaleTrips(db, now)`, ending any trip open past
  `started_at + 6h` at its last catch time, or at `started_at + 1h` when it has no catches, and
  enqueuing the hour-bucket enrichment the normal end path already enqueues.
- Called from the cron worker's scheduled handler before the recompute, and on trip start so a
  stale trip cannot block a new one.
- Tests: a trip with catches closes at the last catch. A skunked open trip closes at one hour. A
  trip inside the window is untouched. Closing twice changes nothing.

> **As built:** the threshold is `MAX_TRIP_DURATION_MS` (48h), not 6h, per the note above. The
> sweep runs on `POST /api/sync` rather than in the cron worker — sync is where activity is
> reported, it already holds the queue binding, and putting it there avoided a second copy of the
> rule in a worker that has no `ENRICH_QUEUE`.

### Task 1 · `packages/patterns` — bucketing

Pure functions, one per dimension, each mapping a trip-hour row to a bucket key or `null` when
the input is absent. Nullable tolerance is the norm here, not an edge case: gauge coverage is
partial by design, and a missing reading must drop that hour from that dimension only.

Dimensions per §08: `pressure_trend`, `sky` from `cloud_pct`, `wind` banded calm, light and
strong, `water_temp` in 5°C bands, `moon` quartiles, `time_block` relative to sunrise, `season`,
`lure_family`, `lure_color`.

Boundary tests sit exactly on every band edge — 8 and 20 kph, each 5°C multiple, 90 minutes
either side of sunrise, each quartile cut — because a band edge is where an off-by-one hides.

### Task 2 · `packages/patterns` — rate math and tiers

`computePatterns(rows, options): PatternResult[]`, zero I/O, taking already-joined rows.

- Baseline per scope, user skipped under 10 total hours.
- `bucket_rate / baseline_rate`, surfaced only at 3 or more exposure hours, 3 or more catches,
  and a multiplier at or above 1.5 or at or below 0.5. Negative patterns surface on equal terms.
- Tiers per §08, including the distinct-trip minimums that are the whole defence against one
  lucky evening faking a pattern.
- Scopes: `all`, plus one per water body that clears the same gate.
- Determinism by construction. Group into `Map`s, iterate keys in sorted order, sum integer
  hours, break every tie on the bucket key. Nothing depends on input order, which is what makes
  the property test pass rather than the property test being what makes it true.

### Task 3 · `packages/patterns` — combos and the anti-confounding rule

Pairwise combos over the top single dimensions only. A combo surfaces only if it beats its best
parent's multiplier by 25% or more, so chartreuse plus falling at 3.1× dies quietly when
chartreuse alone is 3.0× everywhere. Tests cover a combo that clears its parent, one that does
not, and one whose parent never surfaced at all.

### Task 4 · Coverage gate and the shuffle property

- `@vitest/coverage-v8` in `packages/patterns`, thresholds at 100 for branches, statements,
  functions and lines, wired into `pnpm test` so CI fails on a regression rather than someone
  noticing one.
- A `fast-check` property test: for any generated row set, shuffling the input leaves the output
  byte-identical after a canonical sort. This is the test that makes the purity claim real.

### Task 5 · Schema additions

Extended in `packages/schema` first, as the build rules require, before either side reads them.

- `patternSchema`, a full card: dimension, bucket, catches, hours, rate, baseline, multiplier,
  confidence, distinct trips, scope, plain-English statement, sparkline series.
- `patternTeaserSchema`, the redacted free-tier shape from D3.
- `patternFeedSchema`, the tier-tagged response carrying the true total and the excluded
  open-trip count.
- `pushSubscriptionSchema` for Task 10.

### Task 6 · Migration 0008

Append-only, as always.

- `pattern_runs`, a per-user recompute cursor and last-run timestamp, so a nightly pass that runs
  out of budget resumes instead of restarting.
- `push_subscriptions`: endpoint, p256dh, auth, user, created_at, unique on the endpoint.
- `users.first_pattern_notified_at`, the flag that keeps the first-pattern push first.
- Migration 0004's unique index already covers `conditions(trip_id, hour_bucket)`. Confirm the
  planner uses it before adding anything.

### Task 7 · Cron worker — chunked nightly recompute

The scheduled handler stops doing the math itself. It auto-closes stale trips, then enqueues one
job per user due for recompute onto a new `PATTERN_QUEUE`, and a queue consumer in the same
worker computes one user per message.

This reuses the Epic 2 pattern deliberately. Per-message isolation gives each user their own CPU
budget, retries and dead-lettering come free, and the 50ms rule becomes a budget check inside one
message rather than bookkeeping across a single long invocation. A user whose math exceeds the
budget re-queues from its cursor in `pattern_runs`.

Writes replace that user's `pattern_cache` rows for the scope in one `db.batch`, so a reader
never sees a half-written feed.

Tests: a user under 10 hours is skipped. A budget overrun re-queues, and the resumed run produces
the same rows as an uninterrupted one. A redelivered message writes no duplicates.

### Task 8 · API — `GET /api/patterns`

Reads `pattern_cache`, sorted by absolute multiplier per §09. Pro gets full cards. Free gets the
true count and teasers per D3. Both get the excluded open-trip count so the empty state can
explain itself. Tests assert that a free response contains no bucket, multiplier or count
anywhere in the payload — the paywall proven at the wire, not at the stylesheet.

### Task 9 · Web — the Patterns tab

The bottom nav gets its second real tab, and the epic's retention moment gets built.

- Card: plain-English statement, multiplier chip, sparkline, sample-size footer, confidence
  badge, with "Early signal" labelled honestly and never oversold.
- Free: real blurred placeholders and the true count. "3 patterns found in your fishing. Unlock
  Pro."
- Pro with thin data: the progress meter, "7 of ~20 catches until patterns emerge", plus the best
  early signals.
- Empty states get built, not skipped. They carry the free-to-Pro narrative and the packet says
  so twice.

### Task 10 · First-pattern push

Per D4, and last so the rest ships without it.

`WebPushRegistrar.register()` for real, a subscription POST, VAPID keys as Worker secrets, an
ES256 JWT via Web Crypto, and one send from the queue consumer when a user's first `solid`
pattern appears and `first_pattern_notified_at` is null. That flag is set in the same batch that
writes the cache, so a retry cannot send twice.

---

## Acceptance for Epic 4

| Packet criterion | How it is proven |
| --- | --- |
| 100% branch coverage | Vitest v8 thresholds at 100 in `packages/patterns`, enforced in CI |
| Shuffle-invariance property test | `fast-check`: shuffled input, byte-identical output |
| 50ms per user or re-queue | A row budget, not a timer (a Worker clock does not advance on pure CPU); a resumed run matches an uninterrupted one |
| Free user sees true count, blurred cards | API test asserts no bucket, multiplier or count in a free payload |

Plus a spot-check in `docs/epic-4-acceptance.md` in the Epic 3 style: `pattern_cache` rows
reconciled against raw SQL over a known fixture, written when the epic closes.

## Carried into Epic 5

- GPS-drift auto-close, the other half of §04 F2.
- Real-water validation, one real catch and one real skunked trip, still open from Epics 2 and 3.
- Wilson score intervals, if wanted later, slot into `packages/patterns` without a schema change.
