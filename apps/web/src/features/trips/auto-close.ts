import { distanceKm, type Position } from '../../lib/geo'

/** F2's auto-close thresholds, straight from the packet: prompt after 6 hours of nothing
 * happening, or once the angler is 20 km from where the trip is anchored. */
export const IDLE_MS = 6 * 60 * 60 * 1000
export const DRIFT_KM = 20

/** How long "Still fishing" silences the prompt. Long enough not to nag on a dawn-to-dusk day,
 * short enough that a genuinely forgotten trip still gets caught before the next morning. */
export const SNOOZE_MS = 6 * 60 * 60 * 1000

/** The floor an auto-closed trip's duration is held to, matching the server's orphan-catch trip
 * (workers/api upsertOrphanTrip). See suggestedEndAt for why a trip can't end at zero. */
export const MIN_TRIP_MS = 60 * 60 * 1000

export type AutoCloseReason = 'idle' | 'drift'

export interface AutoCloseInput {
  startedAt: number
  /** The most recent catch on this trip, or null for a trip that hasn't caught anything. */
  lastCatchAt: number | null
  now: number
  /** Current fix, or null when location is unavailable — drift simply isn't checked then. */
  position: Position | null
  /** What the trip is anchored to: its water's centroid, else its first catch. null when
   * neither exists, which also means drift can't be judged. */
  anchor: Position | null
  /** Set by "Still fishing"; prompts stay quiet until then. */
  snoozedUntil?: number | null
}

/** The last thing we know happened on this trip. */
export function lastActivityAt({ startedAt, lastCatchAt }: Pick<AutoCloseInput, 'startedAt' | 'lastCatchAt'>): number {
  return Math.max(startedAt, lastCatchAt ?? startedAt)
}

/** Why the angler should be asked whether the trip is over, or null to stay quiet.
 *
 * Idle is checked before drift because it's the more certain signal: six hours of nothing is
 * nothing, whereas 20 km of drift on a 68 km reservoir can still be the same trip (ADR-0009's
 * problem again), which is why this prompts rather than closing anything by itself. */
export function autoCloseReason(input: AutoCloseInput): AutoCloseReason | null {
  if (input.snoozedUntil != null && input.now < input.snoozedUntil) return null

  if (input.now - lastActivityAt(input) >= IDLE_MS) return 'idle'

  if (input.position && input.anchor && distanceKm(input.position, input.anchor) >= DRIFT_KM) return 'drift'

  return null
}

/** When an auto-closed trip should be recorded as having ended.
 *
 * The last thing that happened, not the moment we noticed: a trip left running overnight didn't
 * gain fourteen hours of fishing, and hours-on-water is the exposure denominator every rate in
 * the pattern engine divides by (packet §08). The floor matters just as much in the other
 * direction — a skunked trip has no catches, so its last activity is its start, and ending it
 * there would record a zero-hour trip. That would quietly delete the skunk from the denominator,
 * which is the one thing this product must never do. */
export function suggestedEndAt(input: AutoCloseInput): number {
  return Math.max(lastActivityAt(input), input.startedAt + MIN_TRIP_MS)
}
