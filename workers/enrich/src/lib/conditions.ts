import { moonPhaseAt, minutesFromSunrise } from './astro'
import { newId } from './ids'
import { fetchHourlyWeather, nearestPoint } from './open-meteo'
import { classifyPressureTrend, type PressureTrend } from './pressure'
import { seasonFor, type Season } from './season'
import { fetchGaugeReading, findNearestGauge } from './usgs'

const HOUR_MS = 60 * 60 * 1000

export type EnrichStatus = 'done' | 'partial'

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
  discharge_cms: number | null
  season: Season
  source_meta: string
  status: EnrichStatus
}

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

/** Resolves (and caches) the gauge to use for a water body, or null if there's nothing to try
 * (no water body, or none found within range — packet §07: coverage is nullable, never
 * blocking). `attempted` distinguishes "nothing to look for" from "looked and came up empty",
 * which is what decides `done` vs `partial`. */
async function resolveGauge(
  db: D1Database,
  fetchFn: typeof fetch,
  userId: string,
  waterBodyId: string | null,
  location: Location | null,
  atMs: number,
  apiKey?: string,
): Promise<{ gaugeId: string | null; attempted: boolean }> {
  if (!waterBodyId || !location) return { gaugeId: null, attempted: false }

  const wb = await db
    .prepare('SELECT usgs_gauge_id FROM water_bodies WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(waterBodyId, userId)
    .first<{ usgs_gauge_id: string | null }>()
  if (wb?.usgs_gauge_id) return { gaugeId: wb.usgs_gauge_id, attempted: true }

  const nearest = await findNearestGauge(fetchFn, location.lat, location.lng, 15, apiKey, atMs)
  if (nearest) {
    await db
      .prepare('UPDATE water_bodies SET usgs_gauge_id = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND usgs_gauge_id IS NULL')
      .bind(nearest.siteId, waterBodyId, userId)
      .run()
  }
  return { gaugeId: nearest?.siteId ?? null, attempted: true }
}

async function computeConditionsAt(
  fetchFn: typeof fetch,
  atMs: number,
  location: Location | null,
  gauge: { gaugeId: string | null; attempted: boolean },
  apiKey?: string,
): Promise<ConditionsFields> {
  const sources: Record<string, boolean> = {}
  let weatherOk = false
  let air_temp_c = null,
    cloud_pct = null,
    wind_kph = null,
    precip_mm = null,
    pressure_hpa = null
  let pressure_trend: PressureTrend | null = null
  let minutes_from_sunrise: number | null = null

  if (location) {
    minutes_from_sunrise = minutesFromSunrise(atMs, location.lat, location.lng)
    const points = await fetchHourlyWeather(fetchFn, location.lat, location.lng, atMs - 6 * HOUR_MS, atMs)
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

  let water_temp_c = null,
    discharge_cms = null
  let gaugeOk = !gauge.attempted
  if (gauge.attempted) {
    const reading = gauge.gaugeId ? await fetchGaugeReading(fetchFn, gauge.gaugeId, atMs, apiKey) : null
    if (reading) {
      water_temp_c = reading.waterTempC
      discharge_cms = reading.dischargeCms
      gaugeOk = true
    }
    sources.gauge = gaugeOk
  }

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
    discharge_cms,
    season: seasonFor(new Date(atMs), location?.lat ?? null),
    source_meta: JSON.stringify(sources),
    status: weatherOk && gaugeOk ? 'done' : 'partial',
  }
}

const CONDITIONS_COLUMNS =
  'id, user_id, catch_id, trip_id, hour_bucket, air_temp_c, cloud_pct, wind_kph, precip_mm, pressure_hpa, pressure_trend, moon_phase, minutes_from_sunrise, water_temp_c, discharge_cms, season, source_meta, created_at'

/** Enriches one catch (packet §07/§10). Idempotent across queue redelivery: `ON CONFLICT(catch_id)
 * DO UPDATE` means a retried job overwrites the same row instead of duplicating it. */
export async function enrichCatch(db: D1Database, fetchFn: typeof fetch, catchId: string, apiKey?: string): Promise<EnrichStatus> {
  const catchRow = await db
    .prepare('SELECT id, user_id, trip_id, lat, lng, caught_at FROM catches WHERE id = ?')
    .bind(catchId)
    .first<{ id: string; user_id: string; trip_id: string; lat: number | null; lng: number | null; caught_at: number }>()
  if (!catchRow) throw new Error(`enrichCatch: catch ${catchId} not found`)

  const trip = await db
    .prepare('SELECT water_body_id FROM trips WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(catchRow.trip_id, catchRow.user_id)
    .first<{ water_body_id: string | null }>()

  const location: Location | null =
    catchRow.lat != null && catchRow.lng != null
      ? { lat: catchRow.lat, lng: catchRow.lng }
      : await resolveTripLocation(db, catchRow.trip_id, catchRow.user_id)
  const gauge = await resolveGauge(db, fetchFn, catchRow.user_id, trip?.water_body_id ?? null, location, catchRow.caught_at, apiKey)
  const fields = await computeConditionsAt(fetchFn, catchRow.caught_at, location, gauge, apiKey)

  await db
    .prepare(
      `INSERT INTO conditions (${CONDITIONS_COLUMNS}) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(catch_id) WHERE catch_id IS NOT NULL DO UPDATE SET
         air_temp_c = excluded.air_temp_c, cloud_pct = excluded.cloud_pct, wind_kph = excluded.wind_kph,
         precip_mm = excluded.precip_mm, pressure_hpa = excluded.pressure_hpa, pressure_trend = excluded.pressure_trend,
         moon_phase = excluded.moon_phase, minutes_from_sunrise = excluded.minutes_from_sunrise,
         water_temp_c = excluded.water_temp_c, discharge_cms = excluded.discharge_cms,
         season = excluded.season, source_meta = excluded.source_meta`,
    )
    .bind(
      newId(),
      catchRow.user_id,
      catchId,
      fields.air_temp_c,
      fields.cloud_pct,
      fields.wind_kph,
      fields.precip_mm,
      fields.pressure_hpa,
      fields.pressure_trend,
      fields.moon_phase,
      fields.minutes_from_sunrise,
      fields.water_temp_c,
      fields.discharge_cms,
      fields.season,
      fields.source_meta,
      Date.now(),
    )
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
    .prepare('SELECT user_id, water_body_id FROM trips WHERE id = ?')
    .bind(tripId)
    .first<{ user_id: string; water_body_id: string | null }>()
  if (!trip) throw new Error(`enrichTripHours: trip ${tripId} not found`)

  const location = await resolveTripLocation(db, tripId, trip.user_id)
  const gauge = await resolveGauge(db, fetchFn, trip.user_id, trip.water_body_id, location, (hourBuckets[0] ?? Math.floor(Date.now() / HOUR_MS)) * HOUR_MS, apiKey)

  let overallStatus: EnrichStatus = 'done'
  for (const hourBucket of hourBuckets) {
    const atMs = hourBucket * HOUR_MS
    const fields = await computeConditionsAt(fetchFn, atMs, location, gauge, apiKey)
    if (fields.status === 'partial') overallStatus = 'partial'

    await db
      .prepare(
        `INSERT INTO conditions (${CONDITIONS_COLUMNS}) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trip_id, hour_bucket) WHERE trip_id IS NOT NULL AND hour_bucket IS NOT NULL DO UPDATE SET
           air_temp_c = excluded.air_temp_c, cloud_pct = excluded.cloud_pct, wind_kph = excluded.wind_kph,
           precip_mm = excluded.precip_mm, pressure_hpa = excluded.pressure_hpa, pressure_trend = excluded.pressure_trend,
           moon_phase = excluded.moon_phase, minutes_from_sunrise = excluded.minutes_from_sunrise,
           water_temp_c = excluded.water_temp_c, discharge_cms = excluded.discharge_cms,
           season = excluded.season, source_meta = excluded.source_meta`,
      )
      .bind(
        newId(),
        trip.user_id,
        tripId,
        hourBucket,
        fields.air_temp_c,
        fields.cloud_pct,
        fields.wind_kph,
        fields.precip_mm,
        fields.pressure_hpa,
        fields.pressure_trend,
        fields.moon_phase,
        fields.minutes_from_sunrise,
        fields.water_temp_c,
        fields.discharge_cms,
        fields.season,
        fields.source_meta,
        Date.now(),
      )
      .run()
  }
  return overallStatus
}
