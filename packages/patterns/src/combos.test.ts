import { describe, expect, it } from 'vitest'
import { ALL_SCOPE, TOP_DIMENSIONS_FOR_COMBOS, computePatterns } from './compute'
import { build, repeat } from './fixtures'
import type { TripSpec } from './fixtures'

function combos(patterns: { dimension: string }[]) {
  return patterns.filter((p) => p.dimension.includes('+'))
}

describe('pairwise combos', () => {
  it('surfaces a pairing that is genuinely more than either half of it', () => {
    // Chartreuse runs 1.7× on its own and falling pressure runs 1.7× on its own. Fished together
    // they run 3.3×, which is more than either parent can account for.
    const specs: TripSpec[] = repeat(6, {
      hours: 5,
      conditions: { pressure_trend: 'stable' },
      hourOverrides: { 0: { pressure_trend: 'falling' }, 1: { pressure_trend: 'falling' } },
      catches: [
        { hour: 0, color: 'chartreuse' },
        { hour: 0, color: 'chartreuse' },
        { hour: 1, color: 'chartreuse' },
        { hour: 1, color: 'chartreuse' },
        { hour: 2, color: 'chartreuse' },
        { hour: 3, color: 'white' },
      ],
    })
    const report = computePatterns(build(specs))
    const pairing = report.patterns.find(
      (p) => p.dimension === 'lure_color+pressure_trend' && p.bucket === 'chartreuse|falling',
    )
    expect(pairing).toBeDefined()
    // Twenty-four fish against six apportioned hours: half of the twelve falling hours, because
    // two offerings caught on every one of these trips.
    expect(pairing).toMatchObject({ catches: 24, hours: 6, scope: ALL_SCOPE })
    expect(pairing!.multiplier).toBeCloseTo(10 / 3, 10)
  })

  it('suppresses a pairing its parent already explains', () => {
    // Chartreuse is three times baseline everywhere, in every condition. "Chartreuse in falling
    // pressure" is the same finding wearing a hat, and packet §08 says not to sell it twice.
    const report = computePatterns(
      build(
        repeat(6, {
          hours: 6,
          conditions: { pressure_trend: 'stable' },
          hourOverrides: { 0: { pressure_trend: 'falling' }, 1: { pressure_trend: 'falling' } },
          catches: [
            { hour: 0, color: 'chartreuse' },
            { hour: 1, color: 'chartreuse' },
            { hour: 2, color: 'chartreuse' },
            { hour: 3, color: 'chartreuse' },
            { hour: 4, color: 'chartreuse' },
            { hour: 5, color: 'white' },
          ],
        }),
      ),
    )
    const chartreuse = report.patterns.find(
      (p) => p.dimension === 'lure_color' && p.bucket === 'chartreuse',
    )
    expect(chartreuse).toBeDefined()
    const pairing = report.patterns.find((p) => p.bucket === 'chartreuse|falling')
    expect(pairing).toBeUndefined()
  })

  it('pairs at most the top three dimensions, so combos stay linear in practice', () => {
    // Every dimension moves at once. Three dimensions make three pairs; nine would make
    // thirty-six, which is the cost the packet's "top dimensions only" rule exists to avoid.
    const hot = {
      pressure_trend: 'falling',
      cloud_pct: 10,
      wind_kph: 2,
      water_temp_c: 18,
      moon_phase: 0.6,
      minutes_from_sunrise: 30,
      season: 'spring',
    }
    const cold = {
      pressure_trend: 'stable',
      cloud_pct: 90,
      wind_kph: 30,
      water_temp_c: 3,
      moon_phase: 0.1,
      minutes_from_sunrise: 400,
      season: 'winter',
    }
    const report = computePatterns(
      build(
        repeat(6, {
          hours: 4,
          conditions: cold,
          hourOverrides: { 0: hot },
          catches: [
            { hour: 0, color: 'chartreuse', family: 'spinnerbait' },
            { hour: 0, color: 'chartreuse', family: 'spinnerbait' },
            { hour: 0, color: 'chartreuse', family: 'spinnerbait' },
            { hour: 1, color: 'white', family: 'jig' },
          ],
        }),
      ),
    )
    const dimensions = new Set(combos(report.patterns).map((p) => p.dimension))
    const maxPairs = (TOP_DIMENSIONS_FOR_COMBOS * (TOP_DIMENSIONS_FOR_COMBOS - 1)) / 2
    expect(dimensions.size).toBeLessThanOrEqual(maxPairs)
  })

  it('builds no combos at all when no single dimension surfaced', () => {
    const report = computePatterns(
      build(repeat(5, { hours: 4, conditions: { pressure_trend: 'stable' }, catches: [{ hour: 0 }] })),
    )
    expect(combos(report.patterns)).toEqual([])
  })

  it('builds no pairing when the two halves never describe the same fish', () => {
    // Half this angler's catches recorded a family and no colour, the other half a colour and no
    // family. Both dimensions surface on their own; their pairing has nothing to stand on, and
    // must not be manufactured out of the trips' hours.
    const report = computePatterns(
      build(
        repeat(6, {
          hours: 4,
          catches: [
            { hour: 0, family: 'spinnerbait' },
            { hour: 0, family: 'spinnerbait' },
            { hour: 0, family: 'spinnerbait' },
            { hour: 1, family: 'jig' },
            { hour: 2, color: 'chartreuse' },
            { hour: 2, color: 'chartreuse' },
            { hour: 2, color: 'chartreuse' },
            { hour: 3, color: 'white' },
          ],
        }),
      ),
    )
    expect(report.patterns.some((p) => p.dimension === 'lure_family')).toBe(true)
    expect(report.patterns.some((p) => p.dimension === 'lure_color')).toBe(true)
    expect(combos(report.patterns)).toEqual([])
  })

  it('holds a pairing to the same exposure and catch minimums as any other bucket', () => {
    // The pairing is extreme but rests on two fish, so it stays off the feed.
    const report = computePatterns(
      build([
        ...repeat(6, {
          hours: 4,
          conditions: { pressure_trend: 'stable' },
          hourOverrides: { 0: { pressure_trend: 'falling' } },
          catches: [
            { hour: 0, color: 'chartreuse' },
            { hour: 0, color: 'chartreuse' },
            { hour: 1, color: 'white' },
          ],
        }),
        {
          hours: 4,
          conditions: { pressure_trend: 'rising' },
          catches: [{ hour: 0, color: 'orange' }, { hour: 1, color: 'orange' }],
        },
      ]),
    )
    expect(report.patterns.find((p) => p.bucket === 'orange|rising')).toBeUndefined()
  })
})
