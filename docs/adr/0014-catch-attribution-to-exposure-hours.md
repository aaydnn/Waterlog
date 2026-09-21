# ADR-0014: A catch is counted against its trip-hour row, clamped into the trip

Status: accepted
Date: 2026-09-15

## Context

Packet §08 computes `bucket_rate = catches_in_bucket / exposure_hours_in_bucket`. It does not say
which row decides what bucket a catch is in, and there are two candidates that disagree.

Every catch has its own `conditions` row, enriched at the catch's own timestamp. Every hour of
every trip has one too, enriched at the top of that hour. The same hour of the same trip can
therefore carry two pressure readings taken from different points in a six-hour window, and near a
threshold they classify differently: the catch row says `falling`, the hour row says `stable`.

If the numerator is read off catch rows and the denominator off hour rows, the two sides stop
describing the same thing. A bucket can then collect catches against almost no exposure and report
a multiplier of forty, and the card will say it with a straight face.

There is a second, quieter gap. `computeHourBuckets` emits `ceil(duration / 1h)` buckets anchored
at `floor(started_at / 1h)`. A trip from 06:45 to 11:15 is four and a half hours, so it gets five
buckets — hours 6 through 10 — and genuinely covers 06:00 to 11:00. A fish caught at 11:05 is
inside the trip and outside every bucket it has. Dropping it loses a real catch. Counting it
against no hour makes it a numerator with no denominator.

Widening the bucket set to cover hour 11 would fix the gap and break the Epic 2 acceptance
criterion that a 4.5h trip yields exactly five rows, which is also the thing that bounds
enrichment work per trip.

## Decision

**Both sides of every rate come from the trip-hour row.** The engine reads its dimension values
off `ExposureHour` only. A catch contributes a count to the bucket its hour is in and nothing
else. The per-catch `conditions` row keeps its job — it is what the journal's detail sheet shows,
at the resolution the angler actually fished — and is not what the engine counts.

**A catch is attributed to `clamp(floor(caught_at / 1h), firstBucket, lastBucket)`** over the
buckets its own trip has. Inside the trip this is exact. Past the end it counts in the last hour
that was measured, which is the nearest true statement available about the weather it was caught
in.

**A catch that lands in no hour is counted and reported, never dropped silently.**
`PatternReport.unattributed_catches` carries the number: its trip is still open, or its hour's
enrichment never arrived, or the row sits in a hole left by a partial backfill. A feed thinner
than the journal implies should be explainable.

## Consequences

- Rates are internally consistent. A bucket's catches and its hours are the same rows counted two
  ways, so a multiplier cannot be manufactured by a disagreement between two enrichment passes.
- Water temperature provenance (`water_temp_source`, ADR-0008) is read from the hour, not the
  catch, so an angler's own measured reading only reaches the engine through the trip it was taken
  on. That is the right granularity: it is recorded per trip.
- A trip's final partial hour is folded into the last full one. A fish caught at 11:05 on a trip
  that ended at 11:15 is counted as an 10:00-hour fish. The alternative was losing it.
- The unattributed count gives the UI something honest to say, and gives us a number to watch: if
  it climbs, enrichment is failing somewhere, and the pattern feed will be quietly understated
  before anything else shows it.
