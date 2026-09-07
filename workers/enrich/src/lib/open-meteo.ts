/** One hour of Open-Meteo's hourly series, already in the units `conditions` stores (packet §07):
 * Celsius, %, km/h, mm, hPa. */
export interface HourlyWeatherPoint {
  timeMs: number
  airTempC: number | null
  cloudPct: number | null
  windKph: number | null
  precipMm: number | null
  pressureHpa: number | null
}

interface OpenMeteoHourly {
  time: string[]
  temperature_2m?: (number | null)[]
  cloud_cover?: (number | null)[]
  wind_speed_10m?: (number | null)[]
  precipitation?: (number | null)[]
  surface_pressure?: (number | null)[]
}

interface OpenMeteoResponse {
  hourly?: OpenMeteoHourly
}

const FORECAST_API = 'https://api.open-meteo.com/v1/forecast'
const ARCHIVE_API = 'https://archive-api.open-meteo.com/v1/archive'
// The forecast API's `past_days` window is how far back "recent" data can be pulled without
// hitting the (slower-updating, ~5-day-delayed) historical archive.
const RECENT_CUTOFF_MS = 5 * 24 * 60 * 60 * 1000

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Keyless Open-Meteo hourly weather for [fromMs, toMs] (packet §07/§10). Returns null on any
 * fetch/parse failure — enrichment treats a missing weather source as best-effort, never
 * blocking. Recent windows use the forecast API (fresher); older ones use the historical archive.
 */
export async function fetchHourlyWeather(
  fetchFn: typeof fetch,
  lat: number,
  lng: number,
  fromMs: number,
  toMs: number,
): Promise<HourlyWeatherPoint[] | null> {
  const isRecent = Date.now() - toMs <= RECENT_CUTOFF_MS
  const base = isRecent ? FORECAST_API : ARCHIVE_API
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    start_date: isoDate(fromMs),
    end_date: isoDate(toMs),
    hourly: 'temperature_2m,cloud_cover,wind_speed_10m,precipitation,surface_pressure',
    timezone: 'UTC',
  })

  try {
    const res = await fetchFn(`${base}?${params.toString()}`)
    if (!res.ok) return null
    const body = (await res.json()) as OpenMeteoResponse
    const hourly = body.hourly
    if (!hourly?.time?.length) return null

    const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
    return hourly.time.map((iso, i) => ({
      // We always request timezone=UTC, but Open-Meteo's timestamps omit the "Z" suffix, so
      // Date.parse would otherwise interpret them in the runtime's local timezone.
      timeMs: Date.parse(`${iso}Z`),
      airTempC: finite(hourly.temperature_2m?.[i]),
      cloudPct: finite(hourly.cloud_cover?.[i]),
      windKph: finite(hourly.wind_speed_10m?.[i]),
      precipMm: finite(hourly.precipitation?.[i]),
      pressureHpa: finite(hourly.surface_pressure?.[i]),
    })).filter((point) => Number.isFinite(point.timeMs))
  } catch {
    return null
  }
}

/** The point in an hourly series closest to `targetMs`, or null for an empty series. */
export function nearestPoint(points: HourlyWeatherPoint[], targetMs: number): HourlyWeatherPoint | null {
  if (points.length === 0) return null
  const point = points.reduce((best, p) => (Math.abs(p.timeMs - targetMs) < Math.abs(best.timeMs - targetMs) ? p : best))
  // Never substitute distant data for a missing hour, especially t-6h pressure.
  return Math.abs(point.timeMs - targetMs) < 3_600_000 ? point : null
}
