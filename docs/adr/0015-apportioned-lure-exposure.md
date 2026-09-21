# ADR-0015: Lure exposure is apportioned per trip, and carries its own baseline

Status: accepted
Date: 2026-09-15

## Context

Packet §08 lists `lure_family` and `lure_color` as pattern dimensions alongside pressure, sky and
wind, and computes all of them the same way: catches in the bucket over exposure hours in the
bucket. Its worked example is "Chartreuse spinnerbaits, falling pressure → 3.2× baseline (11
catches / 14 hrs / 6 trips)".

Those fourteen hours do not exist in the data.

A condition is a property of an hour. Every hour of every trip gets a `conditions` row whether or
not anything was caught, so "fourteen hours of falling pressure" is measured. A lure is a property
of a *catch*. Nothing in the schema records what was tied on during an hour that produced nothing,
and nothing in the capture flow could record it without breaking F1's ten-second acceptance
criterion. So "fourteen hours of chartreuse" is not a measurement that went missing. It was never
observable.

Three ways out, and two of them are traps.

**Divide lure catches by all trip hours.** Every lure's denominator becomes the angler's whole
season. A lure thrown on nine trips out of ten and a lure thrown once that hammered fish both
score against the same hours, so the rate mostly measures how often something was tied on. The
error runs in the direction that flatters whatever the angler already prefers, which is the
direction this engine must never be wrong in — it would confirm the habit it exists to question.

**Drop lure dimensions.** Honest, and it guts the product. The lure shortlist is what F7's
briefing is *for*, and "what do I tie on" is the question anglers actually ask.

**Apportion.** Say what the data supports, and say that it is an approximation.

## Decision

**A trip's hours are shared out evenly among the offerings that caught on it.** One lure caught,
it gets all of them. Three caught, each gets a third. The unit is the hour, so a trip where
pressure changed splits each hour separately and a combo like "chartreuse in falling pressure"
falls out of the same arithmetic.

**A trip where nothing recorded an offering contributes to neither side.** That includes every
skunked trip: nothing was caught, so nothing indicates what was in the water. It also includes a
catch logged without a lure, which is left out of both the numerator and the denominator rather
than being counted as a lure called "none".

**Lure dimensions carry their own baseline.** The condition baseline is every catch over every
hour. The lure baseline is every catch that recorded an offering, over the hours of the trips that
recorded one. A multiplier always compares a bucket against a baseline drawn from the same
population, so the two kinds of card are comparable even though their denominators are built
differently.

Exposure is tallied as integer counts per denominator and summed in denominator order, so a third
of an hour added a thousand times lands on the same number regardless of row order. That is what
keeps the shuffle-invariance property (packet §08) true once fractions enter the arithmetic.

## Consequences

- **Skunked trips leave lure rates alone and still anchor every condition rate.** This is the
  right split: a skunk is strong evidence about the conditions, and no evidence at all about what
  was tied on.
- **An angler who only ever throws one thing gets no lure patterns.** Its rate is the baseline by
  construction, so the multiplier is exactly 1. That is the honest answer, not a gap: there is
  nothing to compare it against.
- **A lure that catches on trips where it was one of several is measured against a fair share of
  those hours**, so a specialist lure fished briefly can out-rate a workhorse, which is the finding
  worth surfacing.
- **The card must say so.** The sample-size footer carries hours that are apportioned rather than
  measured, and the UI does not pretend otherwise.
- **The approximation is visible in one place.** If a later schema records what was tied on per
  hour — a "change lure" tap, or a tackle-box timer — the denominator becomes measured and this
  decision is deleted rather than unwound. Nothing else in the engine depends on it.
