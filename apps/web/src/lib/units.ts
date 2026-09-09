/** Display conversions. The database is metric everywhere (packet §05); US anglers are not, and
 * `users.units` defaults to imperial. Nothing here is ever stored — these are read-side only. */

export function cToF(c: number): number {
  return c * 1.8 + 32
}

export function mmToInches(mm: number): number {
  return mm / 25.4
}

export function gToPounds(g: number): number {
  return g / 453.59237
}

export function kphToMph(kph: number): number {
  return kph / 1.609344
}

export function hpaToInHg(hpa: number): number {
  return hpa * 0.0295299830714
}

export function metersToFeet(m: number): number {
  return m / 0.3048
}

/** "18.5 in" — one decimal is the precision a tape measure actually gives. */
export function formatLength(mm: number | null): string | null {
  return mm === null ? null : `${mmToInches(mm).toFixed(1)} in`
}

/** "3 lb 2 oz" — how anglers say it, not 1.42 kg. */
export function formatWeight(g: number | null): string | null {
  if (g === null) return null
  const totalOunces = Math.round(gToPounds(g) * 16)
  const pounds = Math.floor(totalOunces / 16)
  const ounces = totalOunces % 16
  return pounds > 0 ? `${pounds} lb ${ounces} oz` : `${ounces} oz`
}

export function formatTemp(c: number | null): string | null {
  return c === null ? null : `${Math.round(cToF(c))}°F`
}

export function formatWind(kph: number | null): string | null {
  return kph === null ? null : `${Math.round(kphToMph(kph))} mph`
}

export function formatPressure(hpa: number | null): string | null {
  return hpa === null ? null : `${hpaToInHg(hpa).toFixed(2)} inHg`
}

export function formatDepth(m: number | null): string | null {
  return m === null ? null : `${metersToFeet(m).toFixed(1)} ft`
}

/** Moon phase as a name, not a decimal — 0.5 means nothing to an angler at 5am. */
export function formatMoonPhase(phase: number | null): string | null {
  if (phase === null) return null
  const eighth = Math.round(phase * 8) % 8
  return [
    'New moon',
    'Waxing crescent',
    'First quarter',
    'Waxing gibbous',
    'Full moon',
    'Waning gibbous',
    'Last quarter',
    'Waning crescent',
  ][eighth]!
}

/** "1h 12m after sunrise" / "35m before sunrise" — the framing every fishing report uses. */
export function formatFromSunrise(minutes: number | null): string | null {
  if (minutes === null) return null
  const abs = Math.abs(minutes)
  const hours = Math.floor(abs / 60)
  const mins = abs % 60
  const span = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
  if (minutes === 0) return 'At sunrise'
  return minutes > 0 ? `${span} after sunrise` : `${span} before sunrise`
}
