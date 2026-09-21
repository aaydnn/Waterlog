import type { Dimension } from './buckets'
import { DIMENSIONS } from './buckets'
import type { CatchEvent, ExposureHour, Pattern, PatternInput, PatternReport } from './types'
import { confidenceFor } from './confidence'

export const HOUR_MS = 3_600_000

/** Packet §08: under ten hours on the water there is no baseline worth dividing by. */
export const MIN_BASELINE_HOURS = 10
/** A bucket needs this much exposure and this many catches before it may surface. */
export const MIN_BUCKET_HOURS = 3
export const MIN_BUCKET_CATCHES = 3
/** Surface at or above this, or at or below `WEAK_MULTIPLIER`. Negative patterns are equally
 * actionable: "you rarely catch on bluebird middays" is worth knowing. */
export const STRONG_MULTIPLIER = 1.5
export const WEAK_MULTIPLIER = 0.5
/** How many single dimensions get to form pairs. Combos are quadratic; the packet limits them to
 * the top dimensions for exactly that reason. */
export const TOP_DIMENSIONS_FOR_COMBOS = 3
/** A combo must beat its best parent by this much to be a separate insight (packet §08). */
export const COMBO_UPLIFT = 1.25

export const ALL_SCOPE = 'all'

/**
 * Exact weighted hour count.
 *
 * A lure-dimension hour is worth `1/n` where n is the number of offerings that caught on that
 * trip (see `docs/adr/0015`), and floating-point addition is not associative — summing the same
 * thirds in a different order can land on a different last bit, which would break the
 * shuffle-invariance property the packet requires. So hours are tallied as integer counts per
 * denominator and summed in denominator order. Nothing about the result depends on the order the
 * rows arrived in.
 */
class HourTally {
  private readonly byDenominator = new Map<number, number>()

  add(denominator: number, count: number): void {
    this.byDenominator.set(denominator, (this.byDenominator.get(denominator) ?? 0) + count)
  }

  total(): number {
    let sum = 0
    for (const denominator of [...this.byDenominator.keys()].sort((a, b) => a - b)) {
      sum += this.byDenominator.get(denominator)! / denominator
    }
    return sum
  }
}

/** A trip with its exposure hours indexed, built once and reused by every scope and dimension. */
interface TripFrame {
  water_body_id: string | null
  byBucket: Map<number, ExposureHour>
  hours: ExposureHour[]
  firstBucket: number
  lastBucket: number
}

/** A catch paired with the hour it is counted against. Both sides of every rate come from this
 * hour, never from the catch's own `conditions` row (ADR-0014). */
interface AttributedCatch {
  event: CatchEvent
  hour: ExposureHour
}

function buildTripFrames(hours: ExposureHour[]): Map<string, TripFrame> {
  const frames = new Map<string, TripFrame>()
  for (const hour of hours) {
    const frame = frames.get(hour.trip_id)
    if (frame) {
      frame.byBucket.set(hour.hour_bucket, hour)
      frame.hours.push(hour)
      frame.firstBucket = Math.min(frame.firstBucket, hour.hour_bucket)
      frame.lastBucket = Math.max(frame.lastBucket, hour.hour_bucket)
    } else {
      frames.set(hour.trip_id, {
        water_body_id: hour.water_body_id,
        byBucket: new Map([[hour.hour_bucket, hour]]),
        hours: [hour],
        firstBucket: hour.hour_bucket,
        lastBucket: hour.hour_bucket,
      })
    }
  }
  return frames
}

/**
 * Which exposure hour a catch is counted against: its own epoch hour, held inside the range its
 * trip actually covers.
 *
 * The clamp is not cosmetic. `computeHourBuckets` emits `ceil(duration / 1h)` buckets anchored at
 * the trip's start hour, so a trip from 06:45 to 11:15 covers hours 6 through 10 and a fish
 * caught at 11:05 falls past the end of its own trip. Without the clamp that catch is a numerator
 * with no denominator; with it, it counts in the last hour that was measured.
 */
export function attributeCatch(frame: TripFrame, caughtAt: number): ExposureHour | null {
  const raw = Math.floor(caughtAt / HOUR_MS)
  const clamped = Math.min(Math.max(raw, frame.firstBucket), frame.lastBucket)
  return frame.byBucket.get(clamped) ?? null
}

function attribute(
  frames: Map<string, TripFrame>,
  catches: CatchEvent[],
): { attributed: AttributedCatch[]; unattributed: number } {
  const attributed: AttributedCatch[] = []
  let unattributed = 0
  for (const event of catches) {
    const frame = frames.get(event.trip_id)
    // No frame at all means the trip is still open or never enriched: no hours, so no rate can
    // count this fish. Counted and reported rather than silently dropped.
    const hour = frame ? attributeCatch(frame, event.caught_at) : null
    if (hour) attributed.push({ event, hour })
    else unattributed += 1
  }
  return { attributed, unattributed }
}

const BUCKET_SEPARATOR = '|'
const DIMENSION_SEPARATOR = '+'

function dimensionId(group: Dimension[]): string {
  return group.map((d) => d.id).join(DIMENSION_SEPARATOR)
}

/** Null anywhere in the group means the row cannot be placed, so it counts nowhere. */
function keyOf(values: (string | null)[]): string | null {
  return values.some((v) => v === null) ? null : values.join(BUCKET_SEPARATOR)
}

/**
 * The bucket key for one hour under one offering, with its parts in the group's own order — which
 * is what lets a combo look its parents up by position.
 */
function composeKey(
  group: Dimension[],
  hour: ExposureHour,
  offering: (string | null)[],
): string | null {
  const parts: (string | null)[] = []
  let lurePosition = 0
  for (const dimension of group) {
    if (dimension.kind === 'lure') {
      parts.push(offering[lurePosition]!)
      lurePosition += 1
    } else {
      parts.push(dimension.ofHour!(hour))
    }
  }
  return keyOf(parts)
}

/**
 * The distinct offerings that caught something on one trip — the set the trip's hours are shared
 * out across (ADR-0015).
 *
 * A group with no lure dimension gets a single empty offering, so its hours are counted once and
 * undivided. That is the difference between a measured denominator and an apportioned one.
 */
function distinctOfferings(catches: AttributedCatch[], lureDims: Dimension[]): string[][] {
  if (lureDims.length === 0) return [[]]
  const offerings = new Map<string, string[]>()
  for (const attributedCatch of catches) {
    const values = lureDims.map((d) => d.ofCatch!(attributedCatch.event))
    const key = keyOf(values)
    if (key !== null) offerings.set(key, values as string[])
  }
  // Sorted so an hour's share is computed over a set whose order cannot depend on the order the
  // catches arrived in.
  return [...offerings.keys()].sort().map((key) => offerings.get(key)!)
}

interface BucketTally {
  catches: number
  hours: HourTally
  trips: Set<string>
}

interface ScopeData {
  hours: ExposureHour[]
  catches: AttributedCatch[]
  /** Trips in this scope, each with the hours and catches that belong to it. */
  trips: Map<string, { hours: ExposureHour[]; catches: AttributedCatch[] }>
}

function emptyTally(): BucketTally {
  return { catches: 0, hours: new HourTally(), trips: new Set() }
}

function tallyFor(tallies: Map<string, BucketTally>, key: string): BucketTally {
  const existing = tallies.get(key)
  if (existing) return existing
  const fresh = emptyTally()
  tallies.set(key, fresh)
  return fresh
}

interface GroupResult {
  baselineRate: number
  stats: Map<string, { catches: number; hours: number; trips: number }>
}

/**
 * Catches and exposure for one dimension or one pair, over one scope.
 *
 * The split by kind is the heart of it. A condition is a property of an hour, so an hour of
 * falling pressure is a measured fact. A lure is a property of a catch: nothing records what was
 * tied on during an hour that produced nothing, so lure exposure is apportioned rather than
 * measured, and its baseline is drawn from the same apportioned population so a multiplier always
 * compares like with like (ADR-0015).
 */
function tallyGroup(scope: ScopeData, group: Dimension[]): GroupResult {
  const lureDims = group.filter((d) => d.kind === 'lure')
  const tallies = new Map<string, BucketTally>()

  let baselineCatches = 0
  const baselineHours = new HourTally()

  for (const [tripId, trip] of scope.trips) {
    const offerings = distinctOfferings(trip.catches, lureDims)
    // A trip where no catch recorded what it came on says nothing about which offering was in the
    // water, so it contributes to neither side of a lure rate. Condition-only groups always get
    // one empty offering back, so a skunked trip still counts its hours there — which is the
    // whole point of logging skunks.
    if (offerings.length === 0) continue

    baselineHours.add(1, trip.hours.length)
    for (const hour of trip.hours) {
      for (const offering of offerings) {
        const key = composeKey(group, hour, offering)
        if (key !== null) tallyFor(tallies, key).hours.add(offerings.length, 1)
      }
    }

    for (const attributedCatch of trip.catches) {
      const offering = lureDims.map((d) => d.ofCatch!(attributedCatch.event))
      if (offering.some((v) => v === null)) continue
      baselineCatches += 1
      const key = composeKey(group, attributedCatch.hour, offering)
      if (key === null) continue
      const tally = tallyFor(tallies, key)
      tally.catches += 1
      tally.trips.add(tripId)
    }
  }

  const hours = baselineHours.total()
  const stats = new Map<string, { catches: number; hours: number; trips: number }>()
  for (const [key, tally] of tallies) {
    stats.set(key, { catches: tally.catches, hours: tally.hours.total(), trips: tally.trips.size })
  }
  return { baselineRate: hours > 0 ? baselineCatches / hours : 0, stats }
}

function toPattern(
  scopeId: string,
  dimension: string,
  bucket: string,
  stat: { catches: number; hours: number; trips: number },
  baselineRate: number,
): Pattern {
  const rate = stat.catches / stat.hours
  return {
    scope: scopeId,
    dimension,
    bucket,
    catches: stat.catches,
    hours: stat.hours,
    rate,
    baseline_rate: baselineRate,
    multiplier: rate / baselineRate,
    confidence: confidenceFor(stat.catches, stat.hours, stat.trips),
    trips: stat.trips,
  }
}

/** Packet §08's surfacing rule, applied to an already-tallied bucket. */
export function surfaces(pattern: Pick<Pattern, 'catches' | 'hours' | 'multiplier'>): boolean {
  if (pattern.hours < MIN_BUCKET_HOURS) return false
  if (pattern.catches < MIN_BUCKET_CATCHES) return false
  return pattern.multiplier >= STRONG_MULTIPLIER || pattern.multiplier <= WEAK_MULTIPLIER
}

/** How far from ordinary a multiplier is, in either direction, so a 3× lift and a 0.33× collapse
 * rank as the same size of finding. */
export function strength(multiplier: number): number {
  return multiplier >= 1 ? multiplier : 1 / multiplier
}

function groupScope(hours: ExposureHour[], catches: AttributedCatch[]): ScopeData {
  const trips = new Map<string, { hours: ExposureHour[]; catches: AttributedCatch[] }>()
  for (const hour of hours) {
    const trip = trips.get(hour.trip_id)
    if (trip) trip.hours.push(hour)
    else trips.set(hour.trip_id, { hours: [hour], catches: [] })
  }
  for (const attributedCatch of catches) {
    // Every attributed catch came from an hour in this list, so its trip is always present.
    trips.get(attributedCatch.hour.trip_id)!.catches.push(attributedCatch)
  }
  return { hours, catches, trips }
}

function comparePatterns(a: Pattern, b: Pattern): number {
  return (
    a.scope.localeCompare(b.scope) ||
    a.dimension.localeCompare(b.dimension) ||
    a.bucket.localeCompare(b.bucket)
  )
}

function computeScope(scopeId: string, scope: ScopeData): Pattern[] {
  const surfaced: Pattern[] = []
  /** Every bucket's multiplier, surfaced or not — a combo needs its parents' numbers even when
   * neither parent was interesting enough to show. */
  const parentMultipliers = new Map<string, number>()
  const dimensionStrength = new Map<string, number>()

  for (const dimension of DIMENSIONS) {
    const { baselineRate, stats } = tallyGroup(scope, [dimension])
    if (baselineRate <= 0) continue
    for (const [bucket, stat] of stats) {
      const pattern = toPattern(scopeId, dimension.id, bucket, stat, baselineRate)
      parentMultipliers.set(`${dimension.id}${BUCKET_SEPARATOR}${bucket}`, pattern.multiplier)
      if (!surfaces(pattern)) continue
      surfaced.push(pattern)
      const best = dimensionStrength.get(dimension.id) ?? 0
      dimensionStrength.set(dimension.id, Math.max(best, strength(pattern.multiplier)))
    }
  }

  // Pairwise combos of the top single dimensions only. Ranked by their strongest finding, with
  // the dimension id breaking ties so the choice cannot depend on input order.
  const topDimensionIds = [...dimensionStrength.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_DIMENSIONS_FOR_COMBOS)
    .map(([id]) => id)
  const topDimensions = DIMENSIONS.filter((d) => topDimensionIds.includes(d.id))

  for (let i = 0; i < topDimensions.length; i += 1) {
    for (let j = i + 1; j < topDimensions.length; j += 1) {
      const group = [topDimensions[i]!, topDimensions[j]!]
      const { baselineRate, stats } = tallyGroup(scope, group)
      if (baselineRate <= 0) continue
      for (const [bucket, stat] of stats) {
        const pattern = toPattern(scopeId, dimensionId(group), bucket, stat, baselineRate)
        if (!surfaces(pattern)) continue
        // Anti-confounding (packet §08): if chartreuse is 3× everywhere, "chartreuse in falling
        // pressure" at 3.1× is the same finding wearing a hat.
        // Both parents are always present: a combo's buckets are a subset of each parent
        // dimension's own buckets, and only dimensions that surfaced a pattern — which requires a
        // computed baseline — ever get paired.
        const parts = bucket.split(BUCKET_SEPARATOR)
        const parentStrengths = group.map((d, index) =>
          strength(parentMultipliers.get(`${d.id}${BUCKET_SEPARATOR}${parts[index]}`)!),
        )
        if (strength(pattern.multiplier) < COMBO_UPLIFT * Math.max(...parentStrengths)) continue
        surfaced.push(pattern)
      }
    }
  }

  return surfaced
}

export interface ComputeOptions {
  /**
   * Compute only these scopes. The nightly recompute uses it to work through one angler a few
   * scopes at a time and re-queue the rest, so a long history cannot run a single invocation out
   * of CPU (packet §10).
   */
  scopes?: string[]
}

/** Every scope an angler's hours support: all waters, plus each water they were logged on. */
export function scopesIn(hours: ExposureHour[]): Set<string> {
  const scopes = new Set<string>([ALL_SCOPE])
  for (const hour of hours) {
    if (hour.water_body_id !== null) scopes.add(hour.water_body_id)
  }
  return scopes
}

/**
 * The pattern engine: every rate an angler's own data supports, for every scope it supports one
 * in. Pure — the cron worker hands it rows and writes back what comes out (packet §08).
 */
export function computePatterns(input: PatternInput, options?: ComputeOptions): PatternReport {
  const frames = buildTripFrames(input.hours)
  const { attributed, unattributed } = attribute(frames, input.catches)

  const wanted = options?.scopes
  const scopeIds = wanted ? new Set(wanted) : scopesIn(input.hours)

  const patterns: Pattern[] = []
  const skipped: string[] = []
  for (const scopeId of [...scopeIds].sort()) {
    const hours =
      scopeId === ALL_SCOPE ? input.hours : input.hours.filter((h) => h.water_body_id === scopeId)
    // Packet §08: under ten hours there is no baseline, so the scope is skipped rather than
    // guessed at.
    if (hours.length < MIN_BASELINE_HOURS) {
      skipped.push(scopeId)
      continue
    }
    const catches =
      scopeId === ALL_SCOPE
        ? attributed
        : attributed.filter((c) => c.hour.water_body_id === scopeId)
    patterns.push(...computeScope(scopeId, groupScope(hours, catches)))
  }

  patterns.sort(comparePatterns)
  return { patterns, unattributed_catches: unattributed, skipped_scopes: skipped }
}
