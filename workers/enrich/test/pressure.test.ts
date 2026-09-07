import { describe, expect, it } from 'vitest'
import { classifyPressureTrend } from '../src/lib/pressure'

describe('classifyPressureTrend', () => {
  it('is stable at exactly the -1.5 hPa boundary', () => {
    expect(classifyPressureTrend(1000, 1001.5)).toBe('stable')
  })

  it('is falling just past -1.5 hPa', () => {
    expect(classifyPressureTrend(1000, 1001.51)).toBe('falling')
  })

  it('is stable at exactly the +1.5 hPa boundary', () => {
    expect(classifyPressureTrend(1001.5, 1000)).toBe('stable')
  })

  it('is rising just past +1.5 hPa', () => {
    expect(classifyPressureTrend(1001.51, 1000)).toBe('rising')
  })

  it('is stable with no change', () => {
    expect(classifyPressureTrend(1013.25, 1013.25)).toBe('stable')
  })

  it('is falling for a large drop', () => {
    expect(classifyPressureTrend(995, 1010)).toBe('falling')
  })

  it('is rising for a large gain', () => {
    expect(classifyPressureTrend(1010, 995)).toBe('rising')
  })
})
