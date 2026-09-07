import { describe, expect, it } from 'vitest'
import { seasonFor } from '../src/lib/season'

describe('seasonFor', () => {
  it('is winter in January, northern hemisphere', () => {
    expect(seasonFor(new Date(Date.UTC(2026, 0, 15)), 36.16)).toBe('winter')
  })

  it('is summer in July, northern hemisphere', () => {
    expect(seasonFor(new Date(Date.UTC(2026, 6, 15)), 36.16)).toBe('summer')
  })

  it('is spring in April, northern hemisphere', () => {
    expect(seasonFor(new Date(Date.UTC(2026, 3, 15)), 36.16)).toBe('spring')
  })

  it('is fall in October, northern hemisphere', () => {
    expect(seasonFor(new Date(Date.UTC(2026, 9, 15)), 36.16)).toBe('fall')
  })

  it('flips to summer in January, southern hemisphere', () => {
    expect(seasonFor(new Date(Date.UTC(2026, 0, 15)), -33.87)).toBe('summer')
  })

  it('flips to winter in July, southern hemisphere', () => {
    expect(seasonFor(new Date(Date.UTC(2026, 6, 15)), -33.87)).toBe('winter')
  })

  it('defaults to northern-hemisphere banding when lat is null (no GPS)', () => {
    expect(seasonFor(new Date(Date.UTC(2026, 6, 15)), null)).toBe('summer')
  })

  it('treats the equator (lat 0) as northern hemisphere', () => {
    expect(seasonFor(new Date(Date.UTC(2026, 0, 15)), 0)).toBe('winter')
  })
})
