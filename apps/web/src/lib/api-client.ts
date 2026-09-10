import type {
  Catch,
  CatchDetail,
  JournalPage,
  Lure,
  Stats,
  Trip,
  User,
  WaterBody,
  WaterBodyKind,
} from '@waterlog/schema'

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
    water_temp_c: number | null
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

export interface LureCreateRequest {
  name: string
  family?: string | null
  color?: string | null
  cost_cents?: number | null
}

export interface WaterBodyCreateRequest {
  name: string
  kind?: WaterBodyKind | null
  centroid_lat?: number | null
  centroid_lng?: number | null
  nwps_gauge_id?: string | null
  is_home?: 0 | 1
}

/** F3 journal filters. Everything is optional — the bare call is 'my whole journal, newest
 * first'. */
export interface JournalQuery {
  limit?: number
  cursor?: string | null
  species?: string
  water_body_id?: string
  lure_id?: string
  from?: number
  to?: number
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

/** The server rejected a write because the cookie's user isn't the one the caller said it was
 * writing for — the account changed under this tab. Distinct from a plain 409 so the sync
 * engine can stop the flush with everything still queued instead of retrying into the wrong
 * account. */
export class SessionMismatchError extends ApiError {
  constructor(path: string) {
    super(409, `${path} rejected: the signed-in account is not the one this write is for`)
    this.name = 'SessionMismatchError'
  }
}

/** Header naming the user the client believes it is writing for. The server compares it to the
 * session cookie and answers 409 {"error":"session_mismatch"} when they disagree, which is the
 * only thing standing between a queue flushed by a stale tab and another angler's account. */
export const USER_HEADER = 'X-Waterlog-User'

let onUnauthorized: (() => void) | null = null
let onSessionMismatch: (() => void | Promise<void>) | null = null

/** The app registers one handler so an expired session anywhere — a background sync, a stats
 * fetch — puts the whole app back on the sign-in screen instead of each caller inventing its
 * own story about what went wrong. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

/** Same idea, one step less final: the session is valid, it just belongs to somebody else now.
 * The app re-resolves who is actually signed in; nothing is written until it has. */
export function setSessionMismatchHandler(handler: (() => void | Promise<void>) | null): void {
  onSessionMismatch = handler
}

/** Writes that are bound to an account carry it; reads are answered from the cookie alone. */
async function request<T>(path: string, init?: RequestInit, asUserId?: string | null): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    // Merged after the spread, not before: a caller's own headers (the photo upload's
    // content-type) must not be able to drop the account this write is bound to.
    headers: {
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
      ...(asUserId ? { [USER_HEADER]: asUserId } : {}),
    },
  })
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.()
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (body?.error === 'session_mismatch') {
        // Resolve who is really here before returning, so the caller's next decision — and the
        // UI — are made against the real session rather than the one that just got rejected.
        await onSessionMismatch?.()
        throw new SessionMismatchError(path)
      }
    }
    throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} failed (${res.status})`)
  }
  return (await res.json()) as T
}

export const apiClient = {
  health: () => request<HealthResponse>('/api/health'),
  me: () => request<{ user: User }>('/api/me'),
  requestMagicLink: (email: string) =>
    request<{ ok: true }>('/api/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  sync: (body: SyncBatchRequest, asUserId: string | null = null) =>
    request<SyncBatchResponse>('/api/sync', { method: 'POST', body: JSON.stringify(body) }, asUserId),
  listLures: () => request<{ lures: Lure[] }>('/api/lures'),
  createLure: (body: LureCreateRequest) =>
    request<{ lure: Lure }>('/api/lures', { method: 'POST', body: JSON.stringify(body) }),
  journal: (query: JournalQuery = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
    }
    const qs = params.toString()
    return request<JournalPage>(`/api/journal${qs ? `?${qs}` : ''}`)
  },
  catchDetail: (id: string) => request<CatchDetail>(`/api/journal/${id}`),
  stats: () => request<Stats>('/api/stats'),
  listWaterBodies: () => request<{ water_bodies: WaterBody[] }>('/api/water-bodies'),
  createWaterBody: (body: WaterBodyCreateRequest) =>
    request<{ water_body: WaterBody }>('/api/water-bodies', { method: 'POST', body: JSON.stringify(body) }),
  endTrip: (tripId: string, endedAt: number, waterTempC: number | null = null, asUserId: string | null = null) =>
    request<{ trip: Trip }>(
      `/api/trips/${tripId}/end`,
      {
        method: 'PATCH',
        body: JSON.stringify({ ended_at: endedAt, water_temp_c: waterTempC }),
      },
      asUserId,
    ),
  uploadPhoto: (blob: Blob) =>
    request<{ photo_key: string }>('/api/photos', {
      method: 'POST',
      headers: { 'content-type': blob.type },
      body: blob,
    }),
}
