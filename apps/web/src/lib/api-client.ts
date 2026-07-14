/** Minimal typed fetch wrapper for the WaterLog API. Feature endpoints are
 * added in Epics 1+; Epic 0 only needs health. */
export interface HealthResponse {
  ok: boolean
  version: string
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
}
