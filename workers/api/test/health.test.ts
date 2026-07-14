import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { VERSION } from '../src/version'

describe('GET /api/health', () => {
  it('returns ok with the version', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: VERSION })
  })
})
