# ADR-0016: The pattern paywall is enforced on the server, not in CSS

Status: accepted
Date: 2026-09-15

## Context

Packet §09 is specific about the free tier's empty state, and it is one of the better ideas in the
product:

> Patterns locked (free): real blurred cards computed from the user's own data, with the true
> count — "3 patterns found in your fishing. Unlock Pro." Compute for everyone; reveal behind the
> paywall. **The tease must be true.**

Read literally, "real blurred cards" says to send the real cards and blur them. That makes the
paywall a CSS filter. The payload still contains "chartreuse", "3.2×", "11 catches", and anyone
who opens the network tab has the Pro feature for free — as does anyone who curls the endpoint
with a session cookie, which needs no browser at all.

It is also the wrong shape for the rest of the product. Every other ownership rule in this
codebase is enforced in SQL, on the server, because that is the only place it can be enforced.

## Decision

`GET /api/patterns` returns a different document per tier, and the free one never contains what it
is selling.

- **Pro** gets `PatternCard`s: scope, dimension, bucket, catches, hours, rate, baseline,
  multiplier, confidence, trips.
- **Free** gets the true `total` and a `PatternTeaser` per card carrying three things — an id, the
  confidence tier, and a `dimension_label` naming the *kind* of thing the pattern is about ("your
  lure colour", "barometric pressure", "time of day"). No bucket, no multiplier, no counts.

The client renders placeholder cards of the right shape and count, blurred, with the real number
over them. The blur is a rendering of the teaser, not a filter over a card it was given.

`total` is counted in SQL rather than taken from the returned page, which stops at sixty cards.
"Three patterns found in your fishing" has to be the number that is actually there.

An API test asserts against the raw response text, not the parsed object, that no bucket name, no
multiplier and no count appears anywhere in a free angler's payload. The paywall is proved where
it has to hold.

## Consequences

- **The tease stays true and stays a tease.** The count is computed from this angler's own fishing,
  every night, whether or not they have paid. What is withheld is the answer, not the fact that
  there is one.
- **A free angler still learns something honest**: how many patterns they have, how well replicated
  each is, and what sort of thing each is about. That is a better advertisement than a blur, and it
  is all true.
- **Upgrading needs no recompute.** The cache is already there; the tier only decides how much of
  it is serialized. A downgrade re-locks the same way, which Epic 5 needs for Stripe.
- **The client cannot accidentally leak it.** There is nothing in the free payload to leak, so no
  future refactor of the card component can turn the paywall off.
