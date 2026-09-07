# USGS migration: setup and validation

The enrichment worker now uses the modern OGC v0 metadata and continuous-data
endpoints. Production source code makes no requests to the legacy WaterServices
host. Existing cached numeric station IDs remain supported; newly discovered IDs
include `USGS-`. No new database migration is required for this switch.

## API key setup before deployment

Get a key from the [USGS signup page](https://api.waterdata.usgs.gov/signup).
The key is delivered to the email address supplied. Then, from `workers/enrich`,
run the interactive secret command:

```sh
pnpm exec wrangler secret put USGS_API_KEY
```

Paste the key at the prompt, not into a command argument, this repository, or a
chat message. The secret is stored on the `waterlog-enrich` worker. For local
development, put `USGS_API_KEY=...` in `workers/enrich/.dev.vars`; `.dev.vars` and
its variants are ignored by Git. Never use a `VITE_` variable for this key.

The worker also supports keyless requests for low-volume checks. Production
should use a dedicated key and monitor USGS 429 responses; the provider reports
quotas in response headers. Capture remains valid when USGS is unavailable.
The queue retries partial enrichment at most five times, then retains partial data.

No production key was provisioned and no deployment was performed as part of this
local migration. Deploy through the existing CI process after configuring the key.

## Automated and live verification

Normal tests mock the external service and cover pagination, nearest selection,
historical periods, old/new cached IDs, units, missing readings, malformed data,
rate limits, redirects, pagination limits, and credential isolation. The D1 tests
exercise modern station caching and both catch and trip-hour enrichment.

An opt-in live check runs the actual adapter inside Cloudflare's local worker
runtime against public reference stations. It is excluded from normal CI. In
the terminal, from `workers/enrich`:

```sh
pnpm test:usgs-live
```

This small check is keyless and can fail if the provider is unavailable or limits
requests. It uses fixed historical observations for repeatability.

On 2026-09-07, station discovery and historical readings succeeded at Nashville
and Columbia. At 2026-09-06 12:00 UTC, comparison with the old API gave:

| Reference station | Legacy discharge (ft³/s) | Modern discharge converted to m³/s | Result |
| --- | ---: | ---: | --- |
| 03431500, Nashville TN | 1,620 | 45.873216 | Matches |
| 02169500, Columbia SC | 2,070 | 58.615776 | Matches |

Neither streamflow reference station returned water temperature for that check;
null is expected. A third reference station, 03431083, returned **28.8°C** at the
same instant through both APIs. All three live checks passed inside the Workers
runtime. These are migration reference stations, not the founder's selected
fishing waters. Field validation remains deferred until those waters are chosen.

Implementation decisions and source links: [ADR-0007](adr/0007-modern-usgs-api.md).
