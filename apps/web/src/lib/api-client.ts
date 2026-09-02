import type { Catch, Trip } from '@waterlog/schema'

/** Minimal typed fetch wrapper for the WaterLog API. Feature endpoints are
 * added in Epics 1+; Epic 0 only needs health. */
export interface HealthResponse {
  ok: boolean
  version: string
}

export interface SyncBatchRequest {
  trips: Array<{
    client_id: string
    water_body_id: string | null
    started_at: number
    ended_at: number | null
    auto_created: 0 | 1
    planned: 0 | 1
    notes: string | null
  }>
  catches: Array<{
    client_id: string
    trip_id?: string
    lure_id: string | null
    species: string
    caught_at: number
    lat: number | null
    lng: number | null
    photo_key: string | null
    length_mm: number | null
    weight_g: number | null
    depth_m: number | null
    released: 0 | 1 | null
    notes: string | null
  }>
}

export interface SyncBatchResponse {
  trips: Trip[]
  catches: Catch[]
  errors: Array<{ client_id: string; message: string }>
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} failed (${res.status})`)
  }
  return (await res.json()) as T
}

export const apiClient = {
  health: () => request<HealthResponse>('/api/health'),
  sync: (body: SyncBatchRequest) =>
    request<SyncBatchResponse>('/api/sync', { method: 'POST', body: JSON.stringify(body) }),
}
