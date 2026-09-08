import { nwpsGaugeSchema, nwpsStageflowSchema } from '@waterlog/schema'

// NOAA National Water Prediction Service. Keyless, like every other enrichment source (packet §06).
const API = 'https://api.water.noaa.gov/nwps/v1/gauges'
// NWPS marks missing observations with this sentinel rather than null.
const MISSING = -999
// Accept an observation only if it lands within the same hour we asked about, matching the
// tolerance `nearestPoint` applies to weather.
const MAX_AGE_MS = 60 * 60 * 1000

/** A reading is only useful if it is both present and not the missing-data sentinel. */
function real(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value !== MISSING ? value : null
}

/** NWPS gauge handles are short alphanumeric ids (NRST1, WCCS1). Reject anything else rather
 * than interpolating caller data into a URL path. */
export function isGaugeId(lid: string): boolean {
  return /^[A-Za-z0-9]{4,8}$/.test(lid)
}

/** True when a gauge reports reservoir pool stage. NWPS encodes the observed physical element in
 * the second character of `pedts` — 'P' is pool, 'T' is tailwater, 'G' is river stage. This is
 * how reservoirs are identified without a hardcoded lake list. */
export function isPoolGauge(pedts: string | null | undefined): boolean {
  return typeof pedts === 'string' && pedts.charAt(1).toUpperCase() === 'P'
}

export interface PoolReading {
  /** Reservoir surface elevation in feet above datum, or null when unavailable. */
  poolFt: number | null
  /** Observation time, so callers can judge staleness themselves. */
  observedAtMs: number | null
}

/**
 * Hourly pool elevation for one gauge at `atMs`, from the observed series.
 *
 * Uses `/stageflow` rather than the gauge summary because the summary carries only the latest
 * reading, which is wrong for enriching a catch from last week. Returns null on any
 * fetch/parse failure — a missing water source is best-effort, never blocking (packet §07).
 */
export async function fetchPoolElevation(
  fetchFn: typeof fetch,
  lid: string,
  atMs: number,
): Promise<PoolReading | null> {
  if (!isGaugeId(lid) || !Number.isFinite(atMs)) return null

  try {
    const res = await fetchFn(`${API}/${lid.toLowerCase()}/stageflow`)
    if (!res.ok) return null
    const parsed = nwpsStageflowSchema.safeParse(await res.json())
    if (!parsed.success) return null

    const points = parsed.data.observed?.data ?? []
    let best: { ms: number; primary: number | null } | null = null
    for (const point of points) {
      const ms = Date.parse(point.validTime)
      if (!Number.isFinite(ms)) continue
      if (best === null || Math.abs(ms - atMs) < Math.abs(best.ms - atMs)) {
        best = { ms, primary: real(point.primary) }
      }
    }
    // Never substitute a distant hour's level for the one asked about.
    if (best === null || Math.abs(best.ms - atMs) > MAX_AGE_MS) return null
    return { poolFt: best.primary, observedAtMs: best.ms }
  } catch {
    return null
  }
}

/**
 * Confirms a configured gauge exists and reports pool stage, returning its coordinates.
 *
 * Deliberately NOT a proximity search. Pool elevation is uniform across a reservoir, so the
 * right gauge is the one at that lake's dam, which can sit far from the lake's centroid while a
 * neighbouring reservoir's dam sits closer — from Norris Lake's centroid, Cherokee Dam is
 * 26.6 km away and Norris Dam ~40 km, so nearest-wins picks the wrong lake (ADR-0008).
 */
export async function describeGauge(
  fetchFn: typeof fetch,
  lid: string,
): Promise<{ lid: string; name: string; isPool: boolean; lat: number; lng: number } | null> {
  if (!isGaugeId(lid)) return null
  try {
    const res = await fetchFn(`${API}/${lid.toLowerCase()}`)
    if (!res.ok) return null
    const parsed = nwpsGaugeSchema.safeParse(await res.json())
    if (!parsed.success) return null
    const g = parsed.data
    return {
      lid: g.lid,
      name: g.name,
      isPool: isPoolGauge(g.pedts?.observed),
      lat: g.latitude,
      lng: g.longitude,
    }
  } catch {
    return null
  }
}
