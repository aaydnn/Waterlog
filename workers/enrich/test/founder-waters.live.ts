import { it } from 'vitest'
import { fetchGaugeReading, findNearestGauge } from '../src/lib/usgs'

// Opt-in field validation for the founder's chosen waters (packet §10 deferred item).
// Keyless, read-only, never part of CI.
const POINTS = [
  { water: 'Norris TN', spot: 'Norris Dam', lat: 36.2266, lng: -84.0928 },
  { water: 'Norris TN', spot: 'lower Clinch arm', lat: 36.26, lng: -84.0 },
  { water: 'Norris TN', spot: 'mid lake', lat: 36.3, lng: -83.88 },
  { water: 'Norris TN', spot: 'OSM centroid', lat: 36.3572, lng: -83.6848 },
  { water: 'Norris TN', spot: 'Powell arm', lat: 36.42, lng: -83.75 },
  { water: 'Norris TN', spot: 'upper Clinch arm', lat: 36.45, lng: -83.52 },
  { water: 'Norris TN', spot: 'far NE end', lat: 36.48, lng: -83.45 },
  { water: 'Norris TN', spot: 'La Follette arm', lat: 36.4, lng: -84.1 },
  { water: 'Oliphant SC', spot: 'lake/dam', lat: 34.796, lng: -81.183 },
]

it('sweeps gauge coverage across the founder waters', async () => {
  const at = Date.now() - 6 * 3600_000
  const rows: string[] = []
  for (const p of POINTS) {
    const g = await findNearestGauge(fetch, p.lat, p.lng, 15, undefined, at)
    let detail = 'NO GAUGE within 15 km'
    if (g) {
      const r = await fetchGaugeReading(fetch, g.siteId, at)
      const parts: string[] = []
      if (r?.waterTempC != null) parts.push(`temp ${r.waterTempC}C`)
      if (r?.dischargeCms != null) parts.push(`discharge ${r.dischargeCms.toFixed(3)} cms`)
      detail = `${g.siteId} @ ${g.distanceKm.toFixed(1)} km -> ${parts.length ? parts.join(', ') : 'NO READING'}`
    }
    rows.push(`${p.water.padEnd(12)} ${p.spot.padEnd(18)} ${detail}`)
  }
  console.info('\n' + rows.join('\n'))
}, 300_000)
