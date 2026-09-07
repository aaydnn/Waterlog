# ADR-0007: Use modern USGS Water Data APIs

Status: accepted
Date: 2026-09-07

## Context

The startup packet §06 specifies keyless USGS WaterServices. USGS has announced
that these endpoints will retire in Q1 2027. The founder approved migrating now.
The replacement changes response formats, identifiers, discovery queries, and
request quotas; it is not a hostname-only replacement.

## Decision

Use `https://api.waterdata.usgs.gov/ogcapi/v0/collections/` exclusively in the
production enrichment integration:

- `time-series-metadata/items`: spatial bounding box plus a CQL2 filter for
  temperature (00010), discharge (00060), and `Instantaneous` series. Metadata
  already includes station geometry, so a separate monitoring-locations request
  is unnecessary. Apply the exact 15 km great-circle distance after pagination.
- Select series with a period of record covering the catch/trip-hour era. Allow
  seven days of metadata end-date lag, since metadata is refreshed less often
  than observations. This replaces the legacy station-wide `siteStatus=active`
  filter and permits historical stations for offline backfill. A period of
  record does not prove gap-free observations; missing actual readings stay null.
- `continuous/items`: the existing ±3-hour historical window, filtered to the
  station and two parameters. Choose each parameter's nearest valid observation.
  Parse offset timestamps, nulls and numeric strings. Accept degC temperature and
  convert ft^3/s discharge to m^3/s; already-metric discharge is unchanged.
- Cache modern `USGS-...` IDs in the existing TEXT column. Translate old numeric
  IDs when requesting readings. No schema migration or historical-row rewrite.
- Validate provider payloads through `packages/schema`. Follow pagination only
  on the same HTTPS origin and collection path, with ten-page and 15-second
  limits per lookup. An incomplete search fails as a source instead of selecting
  a potentially incorrect nearest station from the first page.
- Support optional `USGS_API_KEY` as a server-side Worker secret, passed only
  via `X-Api-Key`. Configure it for production quotas. Keyless requests remain
  useful for small local checks. Never send it to Open-Meteo, the client, logs,
  or redirects. Workers use `redirect: 'manual'`; non-success responses, including
  redirects and 429 rate limits, follow the existing partial/retry policy.

## Consequences

USGS remains the data source, but the packet's keyless operational assumption
changes: production needs key provisioning. This adds one server secret, not a
client setting. There is no legacy fallback that would silently fail at retirement.
Existing capture, weather, local astronomy, queue payloads, and stored condition
fields retain their interfaces. Gauge caching remains per water body; a cached
station can have a gap for a particular catch, which remains partial.

Ten pages of 1,000 features is a safety limit, not a guarantee of coverage in
arbitrarily dense regions. Request quotas and real-water representativeness
still need operational validation. See `docs/usgs-migration.md` for setup and
live comparison evidence.

## References

- [USGS migration guide](https://api.waterdata.usgs.gov/docs/ogcapi/migration/)
- [Time-series metadata schema](https://api.waterdata.usgs.gov/ogcapi/v0/collections/time-series-metadata/schema?f=html)
- [Continuous observation schema](https://api.waterdata.usgs.gov/ogcapi/v0/collections/continuous/schema?f=html)
- [API keys and quotas](https://api.waterdata.usgs.gov/docs/ogcapi/keys/)
- [WaterServices retirement](https://waterdata.usgs.gov/blog/api-waterservices-decom/)
