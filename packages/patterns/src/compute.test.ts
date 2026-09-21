import { describe, expect, it } from 'vitest'
import { ALL_SCOPE, computePatterns, strength, surfaces } from './compute'
import { build, repeat } from './fixtures'
import type { Pattern } from './types'

function find(patterns: Pattern[], dimension: string, bucket: string, scope = ALL_SCOPE) {
  return patterns.find(
    (p) => p.dimension === dimension && p.bucket === bucket && p.scope === scope,
  )
}

describe('the baseline gate', () => {
  it('skips an angler with under ten hours on the water, however good the data looks', () => {
    const report = computePatterns(
      build([{ hours: 9, conditions: { pressure_trend: 'falling' }, catches: Array(9).fill({}) }]),
    )
    expect(report.patterns).toEqual([])
    expect(report.skipped_scopes).toEqual([ALL_SCOPE])
  })

  it('computes nothing at all for an angler who has caught nothing, without dividing by zero', () => {
    const report = computePatterns(build([{ hours: 20, conditions: { pressure_trend: 'stable' } }]))
    expect(report.patterns).toEqual([])
    expect(report.patterns.every((p) => Number.isFinite(p.multiplier))).toBe(true)
  })
})

describe('condition rates', () => {
  // Five trips, each 4 hours: 1 hour of falling pressure with 2 catches, 3 stable hours with
  // none. Baseline is 10 catches / 20 hours = 0.5/hr; falling runs 10/5 = 2.0/hr.
  const fallingIsHot = build(
    repeat(5, {
      hours: 4,
      conditions: { pressure_trend: 'stable' },
      hourOverrides: { 0: { pressure_trend: 'falling' } },
      catches: [{ hour: 0 }, { hour: 0 }],
    }),
  )

  it('surfaces a bucket that beats the baseline, with the numbers it rests on', () => {
    const pattern = find(computePatterns(fallingIsHot).patterns, 'pressure_trend', 'falling')!
    expect(pattern).toMatchObject({
      catches: 10,
      hours: 5,
      trips: 5,
      rate: 2,
      baseline_rate: 0.5,
      multiplier: 4,
      // Ten fish across five trips, but only five hours of falling pressure to show for it.
      // Packet §08 puts anything under six exposure hours in the early tier however many fish
      // it holds, and the badge says "Early signal" rather than dressing it up.
      confidence: 'early',
    })
  })

  it('surfaces the negative pattern on the same terms — a bucket that costs you is a finding', () => {
    // Stable is 15 hours for 0 catches, so it fails the three-catch minimum. Give it three.
    const input = build([
      ...repeat(5, {
        hours: 4,
        conditions: { pressure_trend: 'stable' },
        hourOverrides: { 0: { pressure_trend: 'falling' } },
        catches: [{ hour: 0 }, { hour: 0 }],
      }),
      { hours: 12, conditions: { pressure_trend: 'stable' }, catches: [{ hour: 0 }, { hour: 1 }, { hour: 2 }] },
    ])
    const stable = find(computePatterns(input).patterns, 'pressure_trend', 'stable')!
    expect(stable.multiplier).toBeLessThanOrEqual(0.5)
    expect(stable.catches).toBe(3)
  })

  it('leaves an ordinary bucket alone — nothing between half and one and a half surfaces', () => {
    const even = build(
      repeat(5, {
        hours: 4,
        conditions: { pressure_trend: 'stable' },
        hourOverrides: { 0: { pressure_trend: 'falling' } },
        catches: [{ hour: 0 }, { hour: 1 }, { hour: 2 }, { hour: 3 }],
      }),
    )
    expect(find(computePatterns(even).patterns, 'pressure_trend', 'falling')).toBeUndefined()
  })

  it('holds back a bucket with too little exposure to mean anything', () => {
    // Two hours of rising pressure, four fish in them: a hot streak, not yet a pattern.
    const input = build([
      ...repeat(5, { hours: 4, conditions: { pressure_trend: 'stable' }, catches: [{ hour: 0 }] }),
      { hours: 2, conditions: { pressure_trend: 'rising' }, catches: [{ hour: 0 }, { hour: 0 }, { hour: 1 }, { hour: 1 }] },
    ])
    expect(find(computePatterns(input).patterns, 'pressure_trend', 'rising')).toBeUndefined()
  })

  it('holds back a bucket with too few catches, however lopsided the rate', () => {
    const input = build([
      ...repeat(5, { hours: 4, conditions: { pressure_trend: 'stable' }, catches: [{ hour: 0 }] }),
      { hours: 4, conditions: { pressure_trend: 'rising' }, catches: [{ hour: 0 }, { hour: 1 }] },
    ])
    expect(find(computePatterns(input).patterns, 'pressure_trend', 'rising')).toBeUndefined()
  })

  it('drops an hour from the dimension it has no reading for, and only that one', () => {
    // Five short trips whose first hour caught fish in calm air but never got a pressure
    // reading, plus one long quiet trip that read fine throughout.
    const input = build([
      ...repeat(5, {
        hours: 4,
        conditions: { pressure_trend: 'stable', wind_kph: 25 },
        hourOverrides: { 0: { pressure_trend: null, wind_kph: 2 } },
        catches: [{ hour: 0 }, { hour: 0 }],
      }),
      { hours: 12, conditions: { pressure_trend: 'stable', wind_kph: 25 }, catches: [{ hour: 0 }, { hour: 1 }, { hour: 2 }] },
    ])
    const report = computePatterns(input)

    // Never a bucket called "null": an absent reading is absent, not a value.
    expect(report.patterns.every((p) => !p.bucket.includes('null'))).toBe(true)
    // Pressure counts 27 of the 32 hours — the five it could not read are simply not there.
    expect(find(report.patterns, 'pressure_trend', 'stable')?.hours).toBe(27)
    // Wind read every one of those same hours, and keeps them.
    expect(find(report.patterns, 'wind', 'calm')?.hours).toBe(5)
    expect(find(report.patterns, 'wind', 'strong')?.hours).toBe(27)
  })
})

describe('attributing a catch to an exposure hour', () => {
  it('counts a fish caught past the trip\'s last measured hour in that last hour', () => {
    // A trip from 06:45 to 11:15 gets five hour buckets, 6 through 10. The 11:05 fish sits past
    // the last of them and would otherwise be a numerator with no denominator.
    const input = build(
      repeat(5, {
        hours: 4,
        conditions: { pressure_trend: 'stable' },
        hourOverrides: { 3: { pressure_trend: 'rising' } },
        lateCatches: [{ minutesPastEnd: 5 }, { minutesPastEnd: 5 }],
      }),
    )
    const report = computePatterns(input)
    expect(report.unattributed_catches).toBe(0)
    // Both late fish landed in the trip's final hour, which was the rising one.
    expect(find(report.patterns, 'pressure_trend', 'rising')).toMatchObject({ catches: 10, hours: 5 })
  })

  it('reports a catch whose trip has no exposure hours at all', () => {
    const input = build([
      ...repeat(5, { hours: 4, conditions: { pressure_trend: 'stable' }, catches: [{ hour: 0 }] }),
      { hours: 0, catches: [{ hour: 0 }] },
    ])
    // An open trip enriches no hours, so its fish can be counted by nothing.
    expect(computePatterns(input).unattributed_catches).toBe(1)
  })

  it('reports a catch that falls in a gap where enrichment never landed', () => {
    const input = build([
      ...repeat(5, { hours: 4, conditions: { pressure_trend: 'stable' }, catches: [{ hour: 0 }] }),
      { hours: 4, conditions: { pressure_trend: 'stable' }, missingHours: [2], catches: [{ hour: 2 }] },
    ])
    expect(computePatterns(input).unattributed_catches).toBe(1)
  })
})

describe('lure rates', () => {
  it('shares a trip\'s hours between the offerings that caught on it', () => {
    // Four trips of four hours. Two offerings caught on each, so each gets two hours of the four.
    const input = build(
      repeat(4, {
        hours: 4,
        catches: [
          { hour: 0, color: 'chartreuse' },
          { hour: 1, color: 'chartreuse' },
          { hour: 2, color: 'chartreuse' },
          { hour: 3, color: 'white' },
        ],
      }),
    )
    const report = computePatterns(input)
    const chartreuse = find(report.patterns, 'lure_color', 'chartreuse')!
    expect(chartreuse.hours).toBe(8) // 16 trip-hours / 2 offerings
    expect(chartreuse.catches).toBe(12)
    expect(chartreuse.baseline_rate).toBe(1) // 16 catches over 16 hours
    expect(chartreuse.multiplier).toBe(1.5)
  })

  it('cannot surface an offering the angler always throws alone', () => {
    const input = build(
      repeat(4, { hours: 4, catches: [{ hour: 0, color: 'chartreuse' }, { hour: 1, color: 'chartreuse' }] }),
    )
    // Its rate *is* the baseline, so the multiplier is exactly 1. A one-lure angler gets no lure
    // patterns, which is the honest answer: there is nothing to compare against.
    expect(find(computePatterns(input).patterns, 'lure_color', 'chartreuse')).toBeUndefined()
  })

  it('leaves a skunked trip out of every lure rate while keeping its condition hours', () => {
    const input = build([
      ...repeat(4, {
        hours: 4,
        conditions: { pressure_trend: 'stable' },
        catches: [
          { hour: 0, color: 'chartreuse' },
          { hour: 1, color: 'chartreuse' },
          { hour: 2, color: 'chartreuse' },
          { hour: 3, color: 'white' },
        ],
      }),
      // A hard skunk: nothing was caught, so nothing says what was tied on.
      { hours: 12, conditions: { pressure_trend: 'rising' } },
    ])
    const report = computePatterns(input)
    // Sixteen hours of lure exposure, not twenty-eight: the skunk cannot be apportioned to an
    // offering, so it is in neither side of a lure rate.
    expect(find(report.patterns, 'lure_color', 'chartreuse')?.hours).toBe(8)
    // And it is fully present in the condition denominator, which is exactly what it is for:
    // sixteen catches over twenty-eight hours, skunk included.
    expect(find(report.patterns, 'pressure_trend', 'stable')?.baseline_rate).toBeCloseTo(16 / 28, 10)
  })

  it('ignores a catch that never recorded what it came on', () => {
    const input = build(
      repeat(4, {
        hours: 4,
        catches: [
          { hour: 0, color: 'chartreuse' },
          { hour: 1, color: 'chartreuse' },
          { hour: 2, color: 'chartreuse' },
          { hour: 3, color: 'white' },
          { hour: 3 },
        ],
      }),
    )
    const chartreuse = find(computePatterns(input).patterns, 'lure_color', 'chartreuse')!
    // Twelve chartreuse fish over eight hours. The four colourless ones are in neither side, so
    // the baseline is sixteen over sixteen rather than twenty over sixteen.
    expect(chartreuse.catches).toBe(12)
    expect(chartreuse.baseline_rate).toBe(1)
  })

  it('leaves a trip out of lure rates entirely when nothing on it recorded an offering', () => {
    const input = build([
      ...repeat(4, {
        hours: 4,
        catches: [
          { hour: 0, color: 'chartreuse' },
          { hour: 1, color: 'chartreuse' },
          { hour: 2, color: 'chartreuse' },
          { hour: 3, color: 'white' },
        ],
      }),
      { hours: 8, catches: [{ hour: 0 }, { hour: 1 }] },
    ])
    const chartreuse = find(computePatterns(input).patterns, 'lure_color', 'chartreuse')!
    expect(chartreuse.hours).toBe(8)
    expect(chartreuse.baseline_rate).toBe(1) // 16/16, not 16/24
  })
})

describe('scopes', () => {
  it('computes a water of its own alongside the all-waters view', () => {
    const input = build([
      ...repeat(4, {
        water: 'lake1',
        hours: 4,
        conditions: { pressure_trend: 'stable' },
        hourOverrides: { 0: { pressure_trend: 'falling' } },
        catches: [{ hour: 0 }, { hour: 0 }, { hour: 0 }],
      }),
      ...repeat(4, { water: 'lake2', hours: 4, conditions: { pressure_trend: 'stable' }, catches: [{ hour: 0 }] }),
    ])
    const report = computePatterns(input)
    expect(report.patterns.some((p) => p.scope === 'lake1')).toBe(true)
    expect(report.patterns.some((p) => p.scope === ALL_SCOPE)).toBe(true)
    expect(find(report.patterns, 'pressure_trend', 'falling', 'lake1')?.hours).toBe(4)
  })

  it('skips a water with too few hours to have a baseline, and says which', () => {
    const input = build([
      ...repeat(5, { water: 'lake1', hours: 4, conditions: { pressure_trend: 'stable' }, catches: [{ hour: 0 }] }),
      { water: 'pond', hours: 3, conditions: { pressure_trend: 'falling' }, catches: [{ hour: 0 }, { hour: 1 }, { hour: 2 }] },
    ])
    const report = computePatterns(input)
    expect(report.skipped_scopes).toEqual(['pond'])
    expect(report.patterns.some((p) => p.scope === 'pond')).toBe(false)
  })

  it('counts an hour with no water in the all-waters view only', () => {
    const input = build([
      ...repeat(5, { hours: 4, conditions: { pressure_trend: 'stable' }, catches: [{ hour: 0 }] }),
    ])
    const report = computePatterns(input)
    expect(report.patterns.every((p) => p.scope === ALL_SCOPE)).toBe(true)
  })
})

describe('computing a subset of scopes', () => {
  const input = build([
    ...repeat(4, {
      water: 'lake1',
      hours: 4,
      conditions: { pressure_trend: 'stable' },
      hourOverrides: { 0: { pressure_trend: 'falling' } },
      catches: [{ hour: 0 }, { hour: 0 }, { hour: 0 }],
    }),
    ...repeat(4, {
      water: 'lake2',
      hours: 4,
      conditions: { pressure_trend: 'stable' },
      hourOverrides: { 0: { pressure_trend: 'falling' } },
      catches: [{ hour: 0 }, { hour: 0 }, { hour: 0 }],
    }),
  ])

  it('computes every scope when none is named', () => {
    const scopes = new Set(computePatterns(input).patterns.map((p) => p.scope))
    expect([...scopes].sort()).toEqual([ALL_SCOPE, 'lake1', 'lake2'])
  })

  it('computes only the scopes asked for, so a long history can be worked through in chunks', () => {
    const report = computePatterns(input, { scopes: ['lake2'] })
    expect(new Set(report.patterns.map((p) => p.scope))).toEqual(new Set(['lake2']))
  })

  it('gives the same numbers for a scope whether it ran alone or with the others', () => {
    const together = computePatterns(input).patterns.filter((p) => p.scope === 'lake1')
    const alone = computePatterns(input, { scopes: ['lake1'] }).patterns
    expect(alone).toEqual(together)
  })
})

describe('the surfacing rule, on its own', () => {
  it.each([
    [{ catches: 3, hours: 3, multiplier: 1.5 }, true],
    [{ catches: 3, hours: 3, multiplier: 0.5 }, true],
    [{ catches: 3, hours: 3, multiplier: 1.49 }, false],
    [{ catches: 3, hours: 3, multiplier: 0.51 }, false],
    [{ catches: 2, hours: 3, multiplier: 3 }, false],
    [{ catches: 3, hours: 2.9, multiplier: 3 }, false],
  ])('%o surfaces: %s', (pattern, expected) => {
    expect(surfaces(pattern)).toBe(expected)
  })
})

describe('strength', () => {
  it('reads a collapse as the same size of finding as the matching lift', () => {
    expect(strength(3)).toBe(3)
    expect(strength(1 / 3)).toBeCloseTo(3)
    expect(strength(1)).toBe(1)
  })
})
