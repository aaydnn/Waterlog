import { usgsPageSchema, usgsReadingFeatureSchema, usgsSeriesFeatureSchema } from '@waterlog/schema'

const API = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections/'
const EARTH_RADIUS_KM = 6371
const WINDOW_MS = 3 * 60 * 60 * 1000
const METADATA_LAG_MS = 7 * 86_400_000
const PARAMETER_FILTER = "parameter_code IN ('00010','00060')"
const CFS_TO_CMS = 0.0283168

export interface GaugeSite {
  siteId: string
  lat: number
  lng: number
  distanceKm: number
}

export interface GaugeReading {
  waterTempC: number | null
  dischargeCms: number | null
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, a)))
}

/** Finish every page before choosing a nearest station/reading. Incomplete results
 * are a source failure, not evidence of no coverage. Bound requests and elapsed time.
 * Keep credentials in headers, and never forward them to a redirect or foreign next link. */
async function fetchFeatures(
  fetchFn: typeof fetch,
  collection: string,
  params: Record<string, string>,
  apiKey?: string,
): Promise<unknown[] | null> {
  const first = new URL(`${API}${collection}/items`)
  first.search = new URLSearchParams({ f: 'json', limit: '1000', ...params }).toString()
  let url: URL | null = first
  const seen = new Set<string>()
  const features: unknown[] = []
  const signal = AbortSignal.timeout(15_000)
  try {
    for (let page = 0; url && page < 10; page++) {
      if (
        url.origin !== first.origin ||
        url.pathname !== first.pathname ||
        url.username ||
        url.password ||
        seen.has(url.href)
      )
        return null
      seen.add(url.href)
      const headers: Record<string, string> = { Accept: 'application/geo+json' }
      if (apiKey) headers['X-Api-Key'] = apiKey
      const response = await fetchFn(url.href, { headers, signal, redirect: 'manual' })
      if (!response.ok) return null // Includes 429: the queue owns bounded backoff.
      const parsed = usgsPageSchema.safeParse(await response.json())
      if (!parsed.success) return null
      features.push(...parsed.data.features)
      const next = parsed.data.links.find((link) => link.rel === 'next')
      url = next ? new URL(next.href, url) : null
    }
    return url ? null : features
  } catch {
    return null // Never log the request or key.
  }
}

/** Station metadata includes geometry, parameter coverage, and period of record.
 * Select a station with an instantaneous series covering the target era, allowing
 * seven days for delayed metadata updates (ADR-0007). Missing actual readings remain null. */
export async function findNearestGauge(
  fetchFn: typeof fetch,
  lat: number,
  lng: number,
  maxKm = 15,
  apiKey?: string,
  atMs = Date.now(),
): Promise<GaugeSite | null> {
  if (
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    !Number.isFinite(lng) ||
    Math.abs(lng) > 180 ||
    !Number.isFinite(maxKm) ||
    maxKm <= 0 ||
    maxKm > 15 ||
    !Number.isFinite(atMs)
  )
    return null
  const latDelta = ((maxKm / EARTH_RADIUS_KM) * 180) / Math.PI
  const south = Math.max(-90, lat - latDelta)
  const north = Math.min(90, lat + latDelta)
  const lngDelta =
    (Math.asin(Math.min(1, Math.sin(maxKm / EARTH_RADIUS_KM) / Math.cos((lat * Math.PI) / 180))) *
      180) /
    Math.PI
  // A full longitude box at poles/antimeridian avoids excluding nearby sites.
  const wrap = south === -90 || north === 90 || lng - lngDelta < -180 || lng + lngDelta > 180
  const bbox = [wrap ? -180 : lng - lngDelta, south, wrap ? 180 : lng + lngDelta, north].join(',')
  const rows = await fetchFeatures(
    fetchFn,
    'time-series-metadata',
    {
      bbox,
      'filter-lang': 'cql2-text',
      filter: `${PARAMETER_FILTER} AND computation_identifier = 'Instantaneous'`,
    },
    apiKey,
  )
  if (!rows) return null

  let nearest: GaugeSite | null = null
  for (const row of rows) {
    const parsed = usgsSeriesFeatureSchema.safeParse(row)
    if (!parsed.success) continue
    const { properties, geometry } = parsed.data
    const begin = Date.parse(properties.begin_utc)
    const end = Date.parse(properties.end_utc)
    if (
      !Number.isFinite(begin) ||
      !Number.isFinite(end) ||
      begin > atMs + WINDOW_MS ||
      end < atMs - METADATA_LAG_MS
    )
      continue
    const [siteLng, siteLat] = geometry.coordinates
    const distanceKm = haversineKm(lat, lng, siteLat, siteLng)
    if (distanceKm > maxKm) continue
    const siteId = properties.monitoring_location_id
    if (
      !nearest ||
      distanceKm < nearest.distanceKm ||
      (distanceKm === nearest.distanceKm && siteId < nearest.siteId)
    ) {
      nearest = { siteId, lat: siteLat, lng: siteLng, distanceKm }
    }
  }
  return nearest
}

/** Accept old cached site numbers as well as modern IDs; no database rewrite needed. */
export async function fetchGaugeReading(
  fetchFn: typeof fetch,
  siteId: string,
  atMs: number,
  apiKey?: string,
): Promise<GaugeReading | null> {
  if (
    !/^(USGS-)?\d+$/.test(siteId) ||
    !Number.isFinite(atMs) ||
    Math.abs(atMs) > 8.64e15 - WINDOW_MS
  )
    return null
  const locationId = siteId.startsWith('USGS-') ? siteId : `USGS-${siteId}`
  const rows = await fetchFeatures(
    fetchFn,
    'continuous',
    {
      monitoring_location_id: locationId,
      datetime: `${new Date(atMs - WINDOW_MS).toISOString()}/${new Date(atMs + WINDOW_MS).toISOString()}`,
      'filter-lang': 'cql2-text',
      filter: PARAMETER_FILTER,
    },
    apiKey,
  )
  if (!rows) return null

  const nearest = new Map<
    string,
    { value: number; distance: number; time: number; approved: boolean }
  >()
  for (const row of rows) {
    const parsed = usgsReadingFeatureSchema.safeParse(row)
    if (!parsed.success) continue
    const p = parsed.data.properties
    if (
      p.monitoring_location_id !== locationId ||
      p.value === null ||
      (typeof p.value === 'string' && p.value.trim() === '')
    )
      continue
    let value = Number(p.value)
    const time = Date.parse(p.time)
    const distance = Math.abs(time - atMs)
    if (
      !Number.isFinite(value) ||
      value === -999999 ||
      !Number.isFinite(time) ||
      distance > WINDOW_MS
    )
      continue
    if (p.parameter_code === '00010') {
      if (p.unit_of_measure !== 'degC') continue
    } else if (p.unit_of_measure === 'ft^3/s') {
      value *= CFS_TO_CMS
    } else if (p.unit_of_measure !== 'm^3/s') continue
    const approved = p.approval_status === 'Approved'
    const best = nearest.get(p.parameter_code)
    // Deterministic ties: earlier sample, then approved, then lower value.
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance &&
        (time < best.time ||
          (time === best.time &&
            (Number(approved) > Number(best.approved) ||
              (approved === best.approved && value < best.value)))))
    ) {
      nearest.set(p.parameter_code, { value, distance, time, approved })
    }
  }
  if (nearest.size === 0) return null
  return {
    waterTempC: nearest.get('00010')?.value ?? null,
    dischargeCms: nearest.get('00060')?.value ?? null,
  }
}
