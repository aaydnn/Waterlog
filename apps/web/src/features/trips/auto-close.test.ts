import { describe, expect, it } from 'vitest'
import { autoCloseReason, DRIFT_KM, IDLE_MS, MIN_TRIP_MS, suggestedEndAt, type AutoCloseInput } from './auto-close'

const DAWN = Date.UTC(2026, 6, 4, 10, 0, 0)
const NORRIS_DAM = { lat: 36.2266, lng: -84.0928 }
const KNOXVILLE = { lat: 35.9606, lng: -83.9207 } // ~34 km from the dam
const BOAT_RAMP_UP_THE_ARM = { lat: 36.3, lng: -84.0 } // ~10 km, still the same lake

function input(overrides: Partial<AutoCloseInput> = {}): AutoCloseInput {
  return {
    startedAt: DAWN,
    lastCatchAt: null,
    now: DAWN + 60 * 60 * 1000,
    position: null,
    anchor: null,
    ...overrides,
  }
}

describe('autoCloseReason', () => {
  it('stays quiet on a trip that is going normally', () => {
    expect(autoCloseReason(input({ lastCatchAt: DAWN + 30 * 60 * 1000 }))).toBeNull()
  })

  it('prompts after six hours with nothing logged', () => {
    expect(autoCloseReason(input({ now: DAWN + IDLE_MS - 1 }))).toBeNull()
    expect(autoCloseReason(input({ now: DAWN + IDLE_MS }))).toBe('idle')
  })

  it('measures idle from the last catch, not the start of the trip', () => {
    const lastCatchAt = DAWN + 5 * 60 * 60 * 1000
    // Eight hours into a trip, but the last fish was three hours ago: still fishing.
    expect(autoCloseReason(input({ lastCatchAt, now: DAWN + 8 * 60 * 60 * 1000 }))).toBeNull()
    expect(autoCloseReason(input({ lastCatchAt, now: lastCatchAt + IDLE_MS }))).toBe('idle')
  })

  it('prompts once the angler is well away from the water', () => {
    expect(autoCloseReason(input({ position: KNOXVILLE, anchor: NORRIS_DAM }))).toBe('drift')
  })

  it('does not mistake moving up the lake for going home', () => {
    // The whole reason this prompts instead of closing: 20 km is inside one reservoir.
    expect(autoCloseReason(input({ position: BOAT_RAMP_UP_THE_ARM, anchor: NORRIS_DAM }))).toBeNull()
  })

  it('skips the drift check when there is no fix or nothing to measure from', () => {
    expect(autoCloseReason(input({ position: null, anchor: NORRIS_DAM }))).toBeNull()
    expect(autoCloseReason(input({ position: KNOXVILLE, anchor: null }))).toBeNull()
  })

  it('prefers idle when both are true, since six hours of silence is the surer signal', () => {
    const reason = autoCloseReason(
      input({ now: DAWN + IDLE_MS, position: KNOXVILLE, anchor: NORRIS_DAM }),
    )
    expect(reason).toBe('idle')
  })

  it('stays quiet while snoozed, and speaks up again once the snooze runs out', () => {
    const snoozedUntil = DAWN + 12 * 60 * 60 * 1000
    expect(autoCloseReason(input({ now: DAWN + IDLE_MS, snoozedUntil }))).toBeNull()
    expect(autoCloseReason(input({ now: snoozedUntil, snoozedUntil }))).toBe('idle')
  })

  it('treats DRIFT_KM as the threshold, not an approximation', () => {
    // A point due north of the anchor, just past the threshold (1 deg latitude ~= 111.19 km).
    const justPast = { lat: NORRIS_DAM.lat + (DRIFT_KM + 0.2) / 111.19, lng: NORRIS_DAM.lng }
    const justInside = { lat: NORRIS_DAM.lat + (DRIFT_KM - 0.2) / 111.19, lng: NORRIS_DAM.lng }
    expect(autoCloseReason(input({ position: justPast, anchor: NORRIS_DAM }))).toBe('drift')
    expect(autoCloseReason(input({ position: justInside, anchor: NORRIS_DAM }))).toBeNull()
  })
})

describe('suggestedEndAt', () => {
  it('ends the trip at the last fish, not when we noticed', () => {
    const lastCatchAt = DAWN + 4 * 60 * 60 * 1000
    expect(suggestedEndAt(input({ lastCatchAt, now: DAWN + 20 * 60 * 60 * 1000 }))).toBe(lastCatchAt)
  })

  it('never records a zero-hour skunk, which would erase it from the denominator', () => {
    // No catches: last activity is the start. A trip that ends when it began is not a trip the
    // pattern engine can count as exposure.
    expect(suggestedEndAt(input({ lastCatchAt: null, now: DAWN + 20 * 60 * 60 * 1000 }))).toBe(DAWN + MIN_TRIP_MS)
  })

  it('holds the same floor for a fish caught in the first minutes', () => {
    const lastCatchAt = DAWN + 5 * 60 * 1000
    expect(suggestedEndAt(input({ lastCatchAt, now: DAWN + IDLE_MS }))).toBe(DAWN + MIN_TRIP_MS)
  })
})
