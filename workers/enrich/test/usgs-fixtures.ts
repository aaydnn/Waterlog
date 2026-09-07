// Minimal OGC features based on the published schemas and live responses checked
// 2026-09-07. Synthetic values keep regression tests independent of live stations.
export function usgsPage(features: unknown[] = [], next?: string) {
  return { type: 'FeatureCollection', features, links: next ? [{ rel: 'next', href: next }] : [] }
}

export function seriesFeature(
  siteId = 'USGS-03431600',
  lng = -86.785,
  lat = 36.165,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      monitoring_location_id: siteId,
      parameter_code: '00060',
      computation_identifier: 'Instantaneous',
      begin_utc: '2000-01-01T00:00:00Z',
      end_utc: '2026-09-07T00:00:00Z',
      ...overrides,
    },
  }
}

export function readingFeature(
  code: string,
  value: unknown,
  atMs: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'Feature',
    properties: {
      monitoring_location_id: 'USGS-03431600',
      parameter_code: code,
      time: new Date(atMs).toISOString(),
      value,
      unit_of_measure: code === '00010' ? 'degC' : 'ft^3/s',
      approval_status: 'Provisional',
      ...overrides,
    },
  }
}
