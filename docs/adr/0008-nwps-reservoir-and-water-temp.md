# ADR-0008: NOAA NWPS for reservoir level, and a two-source water temperature

Status: accepted
Date: 2026-09-08

## Context

`docs/waterlog-startup-packet.md` §06 names USGS as the only water-data source. Field validation
of the founder's chosen waters (recorded in `docs/epic-2-acceptance.md`) showed that source does
not cover them:

- **Norris Lake, TN** — six of eight points sampled across the lake, including the dam, mid-lake
  and the centroid, have no USGS gauge within 15 km. The one reachable station is
  `CLINCH RIVER ABOVE TAZEWELL` (site type: Stream), measuring the river flowing *into* the
  reservoir rather than the lake.
- **Lake Oliphant, SC** — a 40-acre SCDNR state lake. Its nearest match is
  `WILDCAT CREEK BELOW ROCK HILL`, a 29.7 sq mi creek in a different county reading 0.023 cms.
- **Neither water has a water-temperature station within 60 km.** Widening the search radius adds
  more unrelated creeks, not coverage.

This is structural, not bad luck. USGS instruments rivers; TVA impoundments carry TVA
instrumentation. Reservoirs are exactly the water this product targets, so "nearest USGS gauge"
will keep coming up empty or, worse, plausible and wrong.

## Decision

### 1. Add NOAA NWPS as a second water source, for reservoirs

`https://api.water.noaa.gov/nwps/v1` is keyless and public, matching the packet's principle that
every enrichment source is free with no vendor account to lose (§06). It publishes hourly pool
elevation with a forecast. Reservoir gauges are identifiable programmatically — the second
character of `pedts` is `P` — and there are 849 of them nationwide, 17 in Tennessee, covering
essentially every TVA lake. This is general reservoir coverage, not a fix for one lake.

For Norris, `NRST1` gives hourly pool elevation (1012.22 ft against a 1020 ft full pool at the
time of writing). Two new `conditions` columns hold it: `pool_elevation_ft` and `tailwater_ft`,
the latter a generation indicator for tailwater fishing.

### 2. Map pool gauges explicitly, never by proximity

Pool elevation is uniform across a reservoir, so the correct gauge is the one at *that lake's*
dam — which can sit far from the lake's centroid while a **different** reservoir's dam sits
closer. From the Norris centroid, Cherokee Dam's pool gauge is 26.6 km away and Norris Dam's is
~40 km, so a nearest-wins rule silently resolves Norris Lake to Cherokee Reservoir.

`water_bodies.nwps_gauge_id` is therefore set explicitly. `describeGauge` exists to confirm a
configured handle really reports pool stage; it deliberately offers no proximity search.

USGS gauge matching keeps its existing 15 km proximity rule, which is correct for rivers.

### 3. Water temperature comes from a measurement, a gauge, or a model — in that order

No API supplies water temperature for these waters. TVA's own site is behind bot protection, and
EPA's Water Quality Portal holds only a few grab samples a year. So `conditions.water_temp_c` is
filled from, in precedence order:

1. `measured` — the angler's own reading. Most boats show it on the transducer.
2. `gauge` — a USGS 00010 series, when one happens to exist.
3. `modeled` — an exponentially weighted mean of the past 7 days of air temperature
   (τ = 48 h), which reproduces water's thermal lag and its damping of the diurnal swing.

`conditions.water_temp_source` records which, so Epic 4 can weight a measurement above an
estimate rather than treating them as one number.

The measured reading lives on **`trips`**, not `catches`: anglers take one reading per outing,
and F1's ten-second capture is an acceptance criterion (§10), so the capture flow cannot grow a
numeric input. It is entered in the trip banner and sent when the trip ends.

### 4. "No gauge in range" is done, not partial

`computeConditionsAt` previously marked any attempted-but-unmatched gauge lookup `partial`, and
the queue retries `partial` five times with backoff. On a water with no gauge — now known to be
the founder's normal case — that burned five attempts and five Open-Meteo calls per catch and per
trip-hour, forever, for a condition that will never change. A lookup that finds nothing in range
is now `done`, with `source_meta.gauge = 'none-in-range'` recording the fact. A failed fetch
against a gauge we *do* have still returns `partial`, because that genuinely is transient.

## Consequences

- The packet's §06 source list is extended, not replaced; USGS remains the river source.
- A reservoir yields no water data until someone sets its `nwps_gauge_id`. That is deliberate:
  a wrong lake's level is worse than a null.
- The modeled temperature is weakest during spring and autumn turnover, when a deep reservoir's
  surface can move independently of air temperature — which is exactly when it matters most.
  This is the reason the measured reading takes precedence and the source is recorded.
- Open-Meteo's window widened from 6 hours to 7 days to feed the model. Same request count;
  larger response.
- Migration 0006 adds `water_bodies.nwps_gauge_id`, `trips.water_temp_c`, and
  `conditions.pool_elevation_ft` / `tailwater_ft` / `water_temp_source`.

## Alternatives rejected

- **Scraping TVA's lake-level pages.** Authoritative, but Cloudflare-protected (403 to a plain
  request), so a Worker scraping it would be fragile and likely against their terms.
- **Widening the USGS radius past 15 km.** Verified not to help: it returns more unrelated
  creeks, and no temperature station appears within 60 km of either water.
- **Satellite lake-surface temperature** (Sentinel-3 / Copernicus). Real, but heavy — auth,
  NetCDF, latency, and coverage limited to large lakes. Not worth it against a free
  angler-entered number.
- **Proximity-matching pool gauges.** Rejected on the evidence above: it picks the wrong lake.
