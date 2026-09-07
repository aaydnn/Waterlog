import SunCalc from 'suncalc'

/** Moon phase as a 0..1 fraction (0 = new, 0.5 = full), per packet §07's `conditions.moon_phase`.
 * suncalc's arithmetic is pure and local — no network call, so this still honors "computed
 * locally" (see ADR-0006 for why suncalc over the packet's literal hand-rolled formula). */
export function moonPhaseAt(date: Date): number {
  return SunCalc.getMoonIllumination(date).phase
}

/** Signed minutes between `caughtAtMs` and that calendar day's sunrise at (lat, lng); negative
 * means before sunrise. Feeds `conditions.minutes_from_sunrise` for the dawn/dusk time-block
 * dimension (packet §08). suncalc derives Julian day from the Date's absolute epoch ms (not
 * local calendar fields), so this is timezone-independent regardless of runtime host TZ. */
export function minutesFromSunrise(caughtAtMs: number, lat: number, lng: number): number | null {
  // Select the local solar calendar day at noon; getTimes at pre-dawn instants can
  // otherwise choose the previous day's solar cycle.
  const dayMs = 86_400_000
  const offsetMs = lng / 360 * dayMs
  const noon = Math.floor((caughtAtMs + offsetMs) / dayMs) * dayMs + dayMs / 2 - offsetMs
  const times = SunCalc.getTimes(new Date(noon), lat, lng)
  const sunriseMs = times.sunrise.getTime()
  return Number.isFinite(sunriseMs) ? Math.round((caughtAtMs - sunriseMs) / 60_000) : null
}
