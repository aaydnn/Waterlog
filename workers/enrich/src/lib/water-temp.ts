import type { HourlyWeatherPoint } from './open-meteo'

/**
 * Estimated surface water temperature from recent air temperature.
 *
 * Water has vastly more thermal mass than air, so a lake's surface tracks a *damped, lagged*
 * average of air temperature rather than the current reading — it does not follow the diurnal
 * swing, and it trails multi-day trends. This models that with an exponentially weighted mean
 * over the preceding days, which is the cheapest form that gets the two behaviours right.
 *
 * This is an estimate, and `conditions.water_temp_source` records that it is one so Epic 4 can
 * weight a measurement above it. Its known weakness is stratified water in spring and autumn:
 * during turnover a deep reservoir's surface can move independently of air temperature, which is
 * exactly when it matters most to an angler. An angler-entered reading always wins (ADR-0008).
 */

/** Hours of air-temperature history the estimate draws on. */
export const WINDOW_HOURS = 168 // 7 days

/** Exponential decay constant, in hours. Larger = more thermal inertia, slower response. */
const TAU_HOURS = 48

/** A lake surface rarely sits below freezing; ice cover decouples it from air entirely. */
const MIN_SURFACE_C = 0

export function estimateWaterTempC(points: HourlyWeatherPoint[], atMs: number): number | null {
  if (!Number.isFinite(atMs)) return null

  let weighted = 0
  let weight = 0
  for (const point of points) {
    if (point.airTempC === null) continue
    const ageHours = (atMs - point.timeMs) / 3_600_000
    // Only look backwards: future hours say nothing about water already warmed.
    if (ageHours < 0 || ageHours > WINDOW_HOURS) continue
    const w = Math.exp(-ageHours / TAU_HOURS)
    weighted += point.airTempC * w
    weight += w
  }
  if (weight === 0) return null

  const estimate = weighted / weight
  return Math.round(Math.max(MIN_SURFACE_C, estimate) * 10) / 10
}
