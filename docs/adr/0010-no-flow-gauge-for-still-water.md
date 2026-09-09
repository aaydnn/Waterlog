# ADR-0010: No USGS flow gauge for still water

Status: accepted
Date: 2026-09-08

## Context

ADR-0008 established that USGS instruments rivers while reservoirs carry TVA instrumentation, and
added NOAA NWPS pool elevation for lakes. It left the USGS proximity matcher in place for every
water, so a lake still got whatever gauge happened to be nearest.

Two things in production made the cost concrete.

**A wrong reading, cached.** The first real Norris Lake catch came back with
`discharge_cms = 1362` — about 48,000 cfs, a major river and nothing Norris Dam releases. The
catch had been logged away from the lake, and `resolveGauges` matched from the *catch's* GPS, then
wrote the result to `water_bodies.usgs_gauge_id`, pinning the lake to it permanently. That
specific bug is fixed separately (match from the water's centroid; only cache what the centroid
found), but it exposed the deeper one: nothing about a lake makes a nearby river gauge correct.

**A plausible wrong answer is worse than none.** Lake Oliphant's centroid *does* match a gauge
inside the 15 km radius — `WILDCAT CREEK BELOW ROCK HILL`, 14.7 km away in a different county,
reading 0.023 cms (`docs/epic-2-acceptance.md`). Nothing about that number is wrong-looking. It
would flow into the pattern engine as a real dimension and produce confident nonsense: "your
catch rate triples when flow is below 0.03 cms" is a statement about a creek the angler has never
fished.

A reservoir does not have a discharge rate. The quantity is not missing — it does not exist.

## Decision

USGS gauge **discovery by proximity** happens only for water bodies whose `kind` is `river`.

- `lake`, `pond`, `reservoir`, `saltwater` → no search, and `source_meta.gauge` records
  `not-applicable`. Their level, where it exists, comes from NWPS pool elevation (ADR-0008).
- `kind` null (unknown) keeps the existing behaviour and still searches. We do not know that it is
  still water, and silently dropping flow for a river would be its own quiet error. The trip
  banner's add-water form now asks for the kind, so null is a legacy state, not a new one.
- An explicitly configured `usgs_gauge_id` is always honoured, on any kind. Explicit mapping beats
  inference — the same rule NWPS pool gauges already follow.

`not-applicable` is a *permanent* absence like `none-in-range`: the enrichment job is `done`, not
`partial`, and is never retried. The catch detail distinguishes all three in words — "Still water
has no flow to measure", "No gauge covers this water", and "Couldn't reach river level … it'll
fill in if the source comes back" — because a reading that is absent forever and one that is
absent today are different facts, and the angler is entitled to know which they are looking at.

## Consequences

- Lake Oliphant, Norris and every future lake stop acquiring a meaningless flow number, and stop
  caching one.
- Epic 4 never sees `discharge_cms` on a still water, so it cannot build a pattern on it. This is
  the point: the engine's credibility rests on every dimension it uses being real.
- A lake with a genuine USGS lake-elevation station (site type LK) will not find it automatically.
  Set `usgs_gauge_id` by hand on that water; the code will use it.
- Water temperature from a USGS gauge is lost for still waters too. Field validation already found
  no water-temperature station within 60 km of either founder water, so in practice this changes
  nothing: those readings come from the angler or the model (ADR-0008).
