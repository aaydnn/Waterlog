import type { Confidence } from './types'

/**
 * Packet §08's tiers, with the distinct-trip minimums that are the whole point of them.
 *
 * One lucky evening can fake any pattern — pseudo-replication, the classic amateur analytics
 * failure. Eleven fish in a single session is one observation, not eleven, so replication across
 * trips is what a tier is actually measuring.
 */
export const SOLID = { catches: 10, hours: 10, trips: 5 } as const
export const PROMISING = { catches: 5, hours: 6, trips: 3 } as const

export function confidenceFor(catches: number, hours: number, trips: number): Confidence {
  if (catches >= SOLID.catches && hours >= SOLID.hours && trips >= SOLID.trips) return 'solid'
  if (catches >= PROMISING.catches && hours >= PROMISING.hours && trips >= PROMISING.trips) {
    return 'promising'
  }
  return 'early'
}
