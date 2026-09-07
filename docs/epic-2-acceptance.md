# EPIC 2 — Enrichment acceptance and release notes

Date: 2026-09-07

Status: all four automated acceptance criteria pass. Original EPIC 2 validation: 180 tests passed
(81 enrichment, 48 API, 41 web, 9 schema, 1 cron), all workspace typechecks and lint
passed, and the web production build passed. The patterns package has no tests yet
(Epic 4). Cloudflare's Windows test runtime reported temporary-directory cleanup
warnings after successful runs; there were no test failures in the final checks.

Implementation covers weather, six-hour pressure trend, nearest USGS gauge within
15 km with water-body caching, local moon/sun calculations, seasons, and trip-hour
backfill. Field validation on the founder's waters is deferred until waters are chosen.

The subsequent USGS migration replaces legacy WaterServices calls with modern
OGC metadata and historical continuous observations. See [migration setup and live
evidence](usgs-migration.md) and [ADR-0007](adr/0007-modern-usgs-api.md). Production
needs the `USGS_API_KEY` Worker secret; existing cached IDs need no migration.

## Acceptance evidence

| Packet §10 requirement | Automated evidence |
| --- | --- |
| Pressure boundaries at ±1.5 hPa | `workers/enrich/test/pressure.test.ts`: exactly at either boundary is stable; crossing it is falling/rising. |
| Astro matches published ephemeris for 20 dates | `workers/enrich/test/astro.test.ts`: 20 USNO named moon events, plus 7 Nashville sunrise dates; circular phase tolerance 0.03, sunrise tolerance 3 minutes. Also tests local solar-day selection and polar no-sunrise nulls. |
| A 4.5-hour trip yields 5 rows | API tests verify queue buckets; enrichment D1 tests verify five persisted exposure rows without catches, including redelivery idempotency. |
| Missing gauge is partial and never blocks capture | Conditions tests retain weather and local astronomy with null gauge readings; queue tests retain partial rows while retrying at most five times. |

Additional regressions cover completed offline trips, synthetic one-hour trips,
failed queue-send recovery on HTTP replay, owner isolation, missing six-hour
pressure samples, USGS no-data values, and absent coordinates.

## Behavior and operational limits

- Successful queue sends receive a D1 receipt. Retrying an interrupted sync or trip-end
  request repairs unsent jobs. Concurrent requests or a crash between send and receipt
  can deliver duplicates; unique condition indexes and upserts prevent duplicate rows.
- Each incomplete job gets five total attempts with 30, 60, 120, and 240 second delays.
  Useful partial rows are saved on each attempt. Exhausted catch jobs stay `partial`.
  Database outages can prevent persisting rows; exhausted jobs are logged, not proof of
  completed enrichment.
- Trips without a water-body centroid or a GPS-tagged catch still get exposure rows,
  but weather remains null. A location source for such skunked trips is future capture work.
- Hour buckets follow the existing start-anchored convention: `ceil(duration / 1h)`
  consecutive epoch-hour labels beginning at `floor(start / 1h)`. These rows are
  samples, not one full hour of exposure each: Epic 4 must weight them using the
  trip's actual duration, including its final fractional hour.
- No water body means no gauge lookup/cache; weather and astronomy can still complete.
  When a water body has no gauge coverage, conditions are explicitly partial.

## Release

CI applies append-only D1 migrations before worker deployment. Migration 0004 adds
condition uniqueness indexes; 0005 adds queue-send receipts. Apply both before
running the updated API and enrichment worker. No production deployment or historical
production backfill was performed during this implementation.

Existing catches/trips predating enrichment can be queued through replay of their
original sync payloads (using existing client IDs), and existing ended trips through
their trip-end endpoint. For a large production history, prepare a scoped backfill
job after identifying the target account and dataset.

## Deferred field validation

When the founder chooses TN/SC waters, verify the matched gauge's location, reported
parameters, freshness, and whether it represents the water actually fished. Record
missing coverage as an expected limitation, then check one real catch and one skunked
trip end to end. This checks data usefulness; it is separate from the automated code
acceptance criteria. No waters were selected or field coverage claimed in this work.

## Source references and maintenance

- [USNO moon phases for 2026](https://aa.usno.navy.mil/calculated/moon/phases?year=2026)
- [USNO reference API documentation](https://aa.usno.navy.mil/data/api)
- [Open-Meteo historical weather documentation](https://open-meteo.com/en/docs/historical-weather-api)
- [Modern USGS metadata](https://api.waterdata.usgs.gov/ogcapi/v0/collections/time-series-metadata/schema?f=html): non-primary provisional series are retained for 120 days; primary historical records can extend further.
- [USGS retirement notice](https://waterdata.usgs.gov/blog/api-waterservices-decom/): the original packet's WaterServices endpoints retire in Q1 2027. The local implementation now uses the replacement API; deployment remains pending.
