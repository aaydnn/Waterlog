import { moonPhaseAt, minutesFromSunrise } from './astro'
import { newId } from './ids'
import { fetchHourlyWeather, nearestPoint, type HourlyWeatherPoint } from './open-meteo'
import { fetchPoolElevation } from './nwps'
import { classifyPressureTrend, type PressureTrend } from './pressure'
import { seasonFor, type Season } from './season'
import { fetchGaugeReading, findNearestGauge } from './usgs'
import { estimateWaterTempC, WINDOW_HOURS } from './water-temp'

const HOUR_MS = 60 * 60 * 1000

export type EnrichStatus = 'done' | 'partial'
type WaterTempSource = 'measured' | 'gauge' | 'modeled'

interface Location {
  lat: number
  lng: number
}

interface ConditionsFields {
  air_temp_c: number | null
  cloud_pct: number | null
  wind_kph: number | null
  precip_mm: number | null
  pressure_hpa: number | null
  pressure_trend: PressureTrend | null
  moon_phase: number
  minutes_from_sunrise: number | null
  water_temp_c: number | null
  water_temp_source: WaterTempSource | null
  discharge_cms: number | null
  pool_elevation_ft: number | null
  tailwater_ft: number | null
  season: Season
  source_meta: string
  status: EnrichStatus
}

/** Why a water has no USGS gauge. Both are permanent facts, never transient failures, so
 * neither is worth a retry — and the app shows a different sentence for each:
 * - `none-in-range`: nothing within the search radius (ADR-0008).
 * - `not-applicable`: still water. Discharge is a river measurement (ADR-0010). */
type UsgsAbsence = 'none-in-range' | 'not-applicable'

/** The gauges configured for a water body. `usgsAbsence` is null when we have a gauge, and also
 * when there was nothing to look for at all (no water body, no location) — in that case nothing
 * is recorded, because "we didn't look" is not a fact about the water. */
interface GaugeConfig {
  usgsId: string | null
  usgsAbsence: UsgsAbsence | null
  nwpsLid: string | null
}

/** Waters where USGS discharge means nothing: a reservoir does not have a flow rate, and the
 * nearest gauge to one is a river that happens to be close by (ADR-0010). A gauge set by hand on
 * such a water is still honoured — explicit mapping always beats inference. */
const STANDING_WATER_KINDS = new Set(['lake', 'pond', 'reservoir', 'saltwater'])

/** A water body's cached centroid, falling back to any GPS-tagged catch on the trip — most
 * trips have no water body assigned yet (Epic 3 hasn't shipped the picker), and losing weather
 * enrichment entirely for all of them would gut the point of trip-hour backfill. */
async function resolveTripLocation(db: D1Database, tripId: string, userId: string): Promise<Location | null> {
  const trip = await db
    .prepare('SELECT water_body_id FROM trips WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(tripId, userId)
    .first<{ water_body_id: string | null }>()

  if (trip?.water_body_id) {
    const wb = await db
      .prepare('SELECT centroid_lat, centroid_lng FROM water_bodies WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(trip.water_body_id, userId)
      .first<{ centroid_lat: number | null; centroid_lng: number | null }>()
    if (wb?.centroid_lat != null && wb.centroid_lng != null) {
      return { lat: wb.centroid_lat, lng: wb.centroid_lng }
    }
  }

  const anyCatch = await db
    .prepare('SELECT lat, lng FROM catches WHERE trip_id = ? AND user_id = ? AND deleted_at IS NULL AND lat IS NOT NULL AND lng IS NOT NULL LIMIT 1')
    .bind(tripId, userId)
    .first<{ lat: number; lng: number }>()
  return anyCatch ?? null
}

/** Resolves (and caches) the USGS gauge to use for a water body, and reads its configured NWPS
 * pool gauge. The NWPS handle is never discovered by proximity: pool elevation is uniform across
 * a reservoir, so the correct gauge is the one at that lake's dam, which can sit far outside any
 * sane radius while a *neighbouring* reservoir's dam sits closer (ADR-0008). It is set explicitly
 * on the water body instead. */
async function resolveGauges(
  db: D1Database,
  fetchFn: typeof fetch,
  userId: string,
  waterBodyId: string | null,
  location: Location | null,
  atMs: number,
  apiKey?: string,
): Promise<GaugeConfig> {
  if (!waterBodyId) return { usgsId: null, usgsAbsence: null, nwpsLid: null }

  const wb = await db
    .prepare(
      'SELECT usgs_gauge_id, nwps_gauge_id, kind, centroid_lat, centroid_lng FROM water_bodies WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .bind(waterBodyId, userId)
    .first<{
      usgs_gauge_id: string | null
      nwps_gauge_id: string | null
      kind: string | null
      centroid_lat: number | null
      centroid_lng: number | null
    }>()
  const nwpsLid = wb?.nwps_gauge_id ?? null

  if (wb?.usgs_gauge_id) return { usgsId: wb.usgs_gauge_id, usgsAbsence: null, nwpsLid }

  // Still water has no flow to measure, so there is nothing to discover by proximity — the
  // nearest gauge would be a creek in the next county, plausible and wrong (ADR-0010).
  if (wb?.kind && STANDING_WATER_KINDS.has(wb.kind)) {
    return { usgsId: null, usgsAbsence: 'not-applicable', nwpsLid }
  }

  // Match from the water's own centroid, not from wherever this catch was logged. The result is
  // cached against the water body forever, so a single catch logged at home — or on the drive
  // back — would otherwise pin the lake to a gauge near the angler's couch, and every later
  // catch on that water, including ones logged from the dam, would read it.
  const fromCentroid = wb?.centroid_lat != null && wb.centroid_lng != null
  const anchor = fromCentroid ? { lat: wb.centroid_lat as number, lng: wb.centroid_lng as number } : location
  if (!anchor) return { usgsId: null, usgsAbsence: null, nwpsLid }

  const nearest = await findNearestGauge(fetchFn, anchor.lat, anchor.lng, 15, apiKey, atMs)
  // Only a gauge found from the centroid is a fact about the water worth remembering. One found
  // from a catch position serves that catch and is forgotten.
  if (nearest && fromCentroid) {
    await db
      .prepare('UPDATE water_bodies SET usgs_gauge_id = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND usgs_gauge_id IS NULL')
      .bind(nearest.siteId, waterBodyId, userId)
      .run()
  }
  return { usgsId: nearest?.siteId ?? null, usgsAbsence: nearest ? null : 'none-in-range', nwpsLid }
}

async function computeConditionsAt(
  fetchFn: typeof fetch,
  atMs: number,
  location: Location | null,
  gauges: GaugeConfig,
  apiKey?: string,
  measuredWaterTempC: number | null = null,
): Promise<ConditionsFields> {
  const sources: Record<string, boolean | string> = {}
  let weatherOk = false
  let air_temp_c = null,
    cloud_pct = null,
    wind_kph = null,
    precip_mm = null,
    pressure_hpa = null
  let pressure_trend: PressureTrend | null = null
  let minutes_from_sunrise: number | null = null
  let points: HourlyWeatherPoint[] | null = null

  if (location) {
    minutes_from_sunrise = minutesFromSunrise(atMs, location.lat, location.lng)
    // Reaches back far enough to feed the water-temperature model as well as the six-hour
    // pressure trend; Open-Meteo bills this the same as the shorter window (one request).
    points = await fetchHourlyWeather(fetchFn, location.lat, location.lng, atMs - WINDOW_HOURS * HOUR_MS, atMs)
    if (points) {
      const now = nearestPoint(points, atMs)
      const sixAgo = nearestPoint(points, atMs - 6 * HOUR_MS)
      if (now) {
        air_temp_c = now.airTempC
        cloud_pct = now.cloudPct
        wind_kph = now.windKph
        precip_mm = now.precipMm
        pressure_hpa = now.pressureHpa
      }
      if (now?.pressureHpa != null && sixAgo?.pressureHpa != null) {
        pressure_trend = classifyPressureTrend(now.pressureHpa, sixAgo.pressureHpa)
      }
      weatherOk = now !== null && [air_temp_c, cloud_pct, wind_kph, precip_mm, pressure_hpa, pressure_trend].every((value) => value !== null)
    }
    sources.weather = weatherOk
  }

  // A lookup that found no gauge in range is a permanent fact about this location, not a
  // transient failure — retrying it forever burns five attempts per job on every gaugeless
  // water. Only a fetch against a gauge we actually have can fail in a way worth repeating.
  let water_temp_c: number | null = null
  let discharge_cms: number | null = null
  let waterOk = true
  if (gauges.usgsId) {
    const reading = await fetchGaugeReading(fetchFn, gauges.usgsId, atMs, apiKey)
    if (reading) {
      water_temp_c = reading.waterTempC
      discharge_cms = reading.dischargeCms
      sources.gauge = true
    } else {
      waterOk = false
      sources.gauge = false
    }
  } else if (gauges.usgsAbsence) {
    sources.gauge = gauges.usgsAbsence
  }

  let pool_elevation_ft: number | null = null
  const tailwater_ft: number | null = null
  if (gauges.nwpsLid) {
    const pool = await fetchPoolElevation(fetchFn, gauges.nwpsLid, atMs)
    if (pool) {
      pool_elevation_ft = pool.poolFt
      sources.pool = true
    } else {
      waterOk = false
      sources.pool = false
    }
  }

  // Precedence: what the angler measured, then what a gauge read, then the model. A measurement
  // is the actual water at the actual time and always wins (ADR-0008).
  let water_temp_source: WaterTempSource | null = null
  if (measuredWaterTempC !== null) {
    water_temp_c = measuredWaterTempC
    water_temp_source = 'measured'
  } else if (water_temp_c !== null) {
    water_temp_source = 'gauge'
  } else if (points) {
    const modeled = estimateWaterTempC(points, atMs)
    if (modeled !== null) {
      water_temp_c = modeled
      water_temp_source = 'modeled'
    }
  }
  if (water_temp_source !== null) sources.water_temp = water_temp_source

  return {
    air_temp_c,
    cloud_pct,
    wind_kph,
    precip_mm,
    pressure_hpa,
    pressure_trend,
    moon_phase: moonPhaseAt(new Date(atMs)),
    minutes_from_sunrise,
    water_temp_c,
    water_temp_source,
    discharge_cms,
    pool_elevation_ft,
    tailwater_ft,
    season: seasonFor(new Date(atMs), location?.lat ?? null),
    source_meta: JSON.stringify(sources),
    status: weatherOk && waterOk ? 'done' : 'partial',
  }
}

const CONDITIONS_COLUMNS =
  'id, user_id, catch_id, trip_id, hour_bucket, air_temp_c, cloud_pct, wind_kph, precip_mm, pressure_hpa, pressure_trend, moon_phase, minutes_from_sunrise, water_temp_c, water_temp_source, discharge_cms, pool_elevation_ft, tailwater_ft, season, source_meta, created_at'

const CONFLICT_UPDATE = `air_temp_c = excluded.air_temp_c, cloud_pct = excluded.cloud_pct, wind_kph = excluded.wind_kph,
         precip_mm = excluded.precip_mm, pressure_hpa = excluded.pressure_hpa, pressure_trend = excluded.pressure_trend,
         moon_phase = excluded.moon_phase, minutes_from_sunrise = excluded.minutes_from_sunrise,
         water_temp_c = excluded.water_temp_c, water_temp_source = excluded.water_temp_source,
         discharge_cms = excluded.discharge_cms, pool_elevation_ft = excluded.pool_elevation_ft,
         tailwater_ft = excluded.tailwater_ft, season = excluded.season, source_meta = excluded.source_meta`

/** The measured/derived values, in CONDITIONS_COLUMNS order after the identity columns. */
function fieldBindings(fields: ConditionsFields): (string | number | null)[] {
  return [
    fields.air_temp_c,
    fields.cloud_pct,
    fields.wind_kph,
    fields.precip_mm,
    fields.pressure_hpa,
    fields.pressure_trend,
    fields.moon_phase,
    fields.minutes_from_sunrise,
    fields.water_temp_c,
    fields.water_temp_source,
    fields.discharge_cms,
    fields.pool_elevation_ft,
    fields.tailwater_ft,
    fields.season,
    fields.source_meta,
    Date.now(),
  ]
}

/** Enriches one catch (packet §07/§10). Idempotent across queue redelivery: `ON CONFLICT(catch_id)
 * DO UPDATE` means a retried job overwrites the same row instead of duplicating it. */
export async function enrichCatch(db: D1Database, fetchFn: typeof fetch, catchId: string, apiKey?: string): Promise<EnrichStatus> {
  const catchRow = await db
    .prepare('SELECT id, user_id, trip_id, lat, lng, caught_at FROM catches WHERE id = ?')
    .bind(catchId)
    .first<{ id: string; user_id: string; trip_id: string; lat: number | null; lng: number | null; caught_at: number }>()
  if (!catchRow) throw new Error(`enrichCatch: catch ${catchId} not found`)

  const trip = await db
    .prepare('SELECT water_body_id, water_temp_c FROM trips WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(catchRow.trip_id, catchRow.user_id)
    .first<{ water_body_id: string | null; water_temp_c: number | null }>()

  const location: Location | null =
    catchRow.lat != null && catchRow.lng != null
      ? { lat: catchRow.lat, lng: catchRow.lng }
      : await resolveTripLocation(db, catchRow.trip_id, catchRow.user_id)
  const gauges = await resolveGauges(db, fetchFn, catchRow.user_id, trip?.water_body_id ?? null, location, catchRow.caught_at, apiKey)
  const fields = await computeConditionsAt(fetchFn, catchRow.caught_at, location, gauges, apiKey, trip?.water_temp_c ?? null)

  await db
    .prepare(
      `INSERT INTO conditions (${CONDITIONS_COLUMNS}) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(catch_id) WHERE catch_id IS NOT NULL DO UPDATE SET
         ${CONFLICT_UPDATE}`,
    )
    .bind(newId(), catchRow.user_id, catchId, ...fieldBindings(fields))
    .run()

  await db.prepare('UPDATE catches SET enrich_status = ?, updated_at = ? WHERE id = ?').bind(fields.status, Date.now(), catchId).run()
  return fields.status
}

/** Trip-hour backfill (packet §07/§10): one conditions row per exposure hour, skunked or not, so
 * the pattern engine has a denominator. Same idempotency guarantee as enrichCatch, keyed on
 * (trip_id, hour_bucket) instead of catch_id. */
export async function enrichTripHours(
  db: D1Database,
  fetchFn: typeof fetch,
  tripId: string,
  hourBuckets: number[],
  apiKey?: string,
): Promise<EnrichStatus> {
  const trip = await db
    .prepare('SELECT user_id, water_body_id, water_temp_c FROM trips WHERE id = ?')
    .bind(tripId)
    .first<{ user_id: string; water_body_id: string | null; water_temp_c: number | null }>()
  if (!trip) throw new Error(`enrichTripHours: trip ${tripId} not found`)

  const location = await resolveTripLocation(db, tripId, trip.user_id)
  const gauges = await resolveGauges(db, fetchFn, trip.user_id, trip.water_body_id, location, (hourBuckets[0] ?? Math.floor(Date.now() / HOUR_MS)) * HOUR_MS, apiKey)

  let overallStatus: EnrichStatus = 'done'
  for (const hourBucket of hourBuckets) {
    const atMs = hourBucket * HOUR_MS
    const fields = await computeConditionsAt(fetchFn, atMs, location, gauges, apiKey, trip.water_temp_c)
    if (fields.status === 'partial') overallStatus = 'partial'

    await db
      .prepare(
        `INSERT INTO conditions (${CONDITIONS_COLUMNS}) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trip_id, hour_bucket) WHERE trip_id IS NOT NULL AND hour_bucket IS NOT NULL DO UPDATE SET
           ${CONFLICT_UPDATE}`,
      )
      .bind(newId(), trip.user_id, tripId, hourBucket, ...fieldBindings(fields))
      .run()
  }
  return overallStatus
}
