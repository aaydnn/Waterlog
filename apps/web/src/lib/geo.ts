const EARTH_RADIUS_KM = 6371

export interface Position {
  lat: number
  lng: number
}

/** Best-effort GPS fix — never blocks or fails the caller (packet principle 5: capture is
 * instant; everything auto-capturable is auto-captured, but nothing waits on it). */
export function bestEffortPosition(timeoutMs = 3000): Promise<Position | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null)
      return
    }
    const timer = setTimeout(() => resolve(null), timeoutMs)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer)
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
      { timeout: timeoutMs },
    )
  })
}

/** Great-circle distance in km. Good enough at the scales this app cares about (which water
 * am I standing on) — it is never used for anything that needs survey precision. */
export function distanceKm(a: Position, b: Position): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}
