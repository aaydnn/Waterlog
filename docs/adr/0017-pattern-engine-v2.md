# ADR-0017: Pattern engine v2 — comparison, shrinkage, and credibility tiers

Status: accepted
Date: 2026-09-16

Supersedes ADR-0015 for trips that carry tie-on logs. Builds on ADR-0014 (a catch counts against
its trip-hour row) and leaves ADR-0016's server-side redaction unchanged.

## Context

Packet §08 defines a pattern as `bucket_rate / baseline_rate`, where the baseline is the angler's
whole season, and it grades the result on counts alone: three distinct trips for *promising*, five
for *solid*. Epic 4 shipped that, and `docs/epic-4-acceptance.md` records it passing. Fishing it
for a season exposes what the arithmetic cannot see.

**The baseline answers the wrong question.** Dividing by the angler's season-wide rate asks "is
this bucket better than my average day?" — and the answer is mostly geography and calendar. A
smallmouth water in June out-rates a crappie pond in February, so *every* dimension measured on
the June trips comes back hot: the lure, the sky, the pressure, the moon. The card credits
whatever happened to be tied on for the fact that it was June on good water. The angler's real
question is narrower and much harder to flatter: **among the things I could have been doing right
there and then, was this one better?**

**Counts are not credibility.** "Five distinct trips" grades sample size and nothing else. It does
not ask whether the effect could plausibly be 1.0, it does not care that the engine tried three
hundred buckets before surfacing this one, and it does not notice when a single exceptional
evening is carrying the entire result. The v1 tiers therefore promote the loudest accident in the
search, which is backwards for an engine whose stated job is to question the angler's habits
rather than confirm them.

**Raw ratios on thin data are wild.** Four catches against a fifth of the exposure is a 20×
multiplier, printed with a straight face. Nothing in v1 pulls an extreme estimate back toward the
boring explanation, so the cards with the biggest numbers are reliably the ones with the least
evidence behind them.

**And the upgrade the packet reaches for is the wrong tool.** Packet §08 anticipates this
objection and names its intended fix: "if a Wilson score interval upgrade is wanted later, it
slots into `packages/patterns` without schema change." It should not be taken. Wilson is an
interval for a proportion — k successes out of n trials. A catch rate is a count over exposure
time, with no n and no ceiling, and the hours within one trip are not independent draws: a hot
evening produces eleven correlated fish, not eleven observations. Wilson would have put a
respectable-looking interval around the wrong quantity.

## Decision

### The comparison is stratified, and the strata are disclosed

**The multiplier is a Mantel–Haenszel rate ratio against comparable alternatives within the same
water × season**, not the bucket rate over a global baseline. Each stratum contributes catches and
exposure for the bucket and for the alternatives the angler could have chosen in that same
stratum; strata are pooled MH-style rather than averaged, so a stratum with twenty hours outweighs
one with two.

When a stratum is too thin to estimate, the comparison **broadens in fixed order — water × season,
then season, then all of the angler's fishing** — and every finding carries the level it landed on
in `stats.strataLevel`. The receipt sheet renders it verbatim ("compared within same water &
season" / "within same season" / "against all your fishing"). A broadened comparison is a weaker
claim and the card has to say which one it is making.

### The displayed multiplier is shrunk

Every effect is shrunk toward 1 under a normal prior on the log rate ratio with `sd = ln2 / 1.96`
— a prior that treats a doubling as a two-sigma surprise. Thin, extreme estimates get pulled hard;
well-evidenced ones barely move. **The number on the card is the shrunk number**, because a
displayed multiplier the engine does not itself believe is a lie told in a chip.

The effect threshold moves onto the shrunk value and becomes symmetric: **≥ 1.4 or ≤ 1/1.4**,
replacing v1's asymmetric raw `≥ 1.5 / ≤ 0.5`. Symmetry on the log scale means a halving and a
doubling are the same size of finding, which they are.

### Tiers grade credibility, not sample size

- **promising** — CI excludes 1, Benjamini–Hochberg `q ≤ 0.10`, evidence quality ≥ 0.5.
- **solid** — additionally `q ≤ 0.05`, ≥ 5 **exposed** trips, ≥ 3 distinct weeks, quality ≥ 0.7,
  and it survives leave-best-trip-out.
- **any competing explanation caps the finding at *early***, however good its numbers are.

BH runs across everything the engine searched, not across what it chose to show. Correcting only
the survivors would be no correction at all.

**"Distinct trips" now means exposed trips, not catching trips.** v1 counted the trips that
produced fish, which cannot fall below the catch count and so silently rewards clustering. The
denominator is the question — how many separate times did the angler put this in the water — and a
trip that got skunked on it is evidence about it.

### Zero-catch findings

A negative may surface with **fewer than 3 catches when expected catches ≥ 4 and the exact Poisson
upper bound is below 1**. "Nothing in nine hours where I'd expect four fish" is a real finding,
and v1's minimum-count floor suppressed exactly that. No multiplier is displayed for a zero-catch
finding; the summary says "No fish in …", and a ratio against zero would be noise wearing a
number.

### Uncertainty is trip-level and over-dispersed

In place of the packet's proposed Wilson interval, uncertainty is **trip-level Pearson dispersion
(quasi-Poisson)**. The trip is the independent unit, the dispersion factor is estimated from
between-trip variance and clamped at `maxDispersion`, and it widens the interval when one evening
is carrying the result. This is the change that most often turns a v1 card into a v2 non-card, and
it should.

### Combos and specificity

The packet's combo rule stands — a combo must **beat its best parent by 25%** — but it is applied
**on the log scale to shrunk values**, so it survives the change of estimator. Additionally, **a
specific-lure finding must beat both its family and its color.** Without that, one good
spinnerbait mints three cards: the lure, the family, and the chartreuse.

### Scope limits

**Species and bigger-fish outcome families run across all waters only.** Per-water × per-species ×
per-dimension is a combinatorial blowup that buys little at one angler's data volume and costs CPU
on every nightly run.

### Decay (F17) needs a winner's-curse guard

Decay is tested with an **exact conditional binomial on season-matched windows**, with
expected-count offsets and dispersion-scaled counts, **plus a guard: the recent window must also
fail the effect threshold on its own.**

The guard is not decoration. Without it, every freshly discovered pattern immediately "decays",
because the window that discovered it was selected for being extreme and the next window regresses
to the mean by construction. That fires on precisely the findings the angler has just started to
trust. It was caught in testing, and the guard is why the conditional test is safe to surface at
all.

### Exposure supersedes ADR-0015 where tie-on logs exist

ADR-0015 apportioned a trip's hours evenly among the offerings that *caught*, and said in its own
consequences that it should be deleted rather than unwound once a "change lure" tap recorded what
was tied on per hour. `offering_sessions` is that tap.

**Where a trip has tie-on sessions, exposure is measured from them.** Apportionment remains the
fallback for trips without them, and **apportioned exposure is scored 0.4 evidence quality, so it
can never reach *solid* on its own** — it can raise a hypothesis, never confirm one. ADR-0015's
reasoning stays on file as the description of the fallback path.

## Consequences

- **v2 multipliers are smaller than v1's, everywhere.** Shrinkage pulls them in, and the
  same-water/season comparison removes the seasonal tailwind that inflated them. A v1 3.2× landing
  at 1.8× in v2 is the estimator working, not a regression.
- **Thin data produces fewer cards, and says why.** Findings that only ever had one good evening
  behind them now stop at *early* or do not surface. The parity gate treats a v1 card missing from
  v2 as needing a written reason from the receipt — shrinkage, confounder, leave-one-out, or BH —
  or as a failing test.
- **Zero-catch negatives appear for the first time**, and aliased lure/color duplicates collapse.
- **The tiers can now be wrong in a direction the angler can check.** Every surfaced claim carries
  its checks, its confounders and its falsifier, so "the engine is too conservative" becomes an
  argument about a specific receipt rather than a feeling.
- **Packet §08 is superseded on all of the above.** Its worked example and its count-based tier
  table no longer describe the shipped engine.
- **`pattern_cache` keeps its v1 shape through the transition.** The v2 consumer writes into it via
  the `v2ToPatternCache` adapter so the existing feed keeps working until the parity gate passes
  and the feed moves to `pattern_findings`.
- **Engine math changes bump `ENGINE_VERSION`.** The lifecycle record uses it to tell "the engine
  changed its mind" from "the fishing changed", which is the difference between an apology and a
  finding.
