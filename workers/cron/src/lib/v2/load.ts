import type {
  CatchInput,
  ConditionSlice,
  EffortSource,
  EngineInput,
  FindingRecord,
  HypothesisInput,
  OfferingInput,
  OfferingSessionInput,
  Season,
  TripInput,
} from '@waterlog/pattern-engine'

/**
 * Reading one angler's history out of D1 in the shape the v2 engine wants (ADR-0017, brief §5).
 *
 * Same contract as the v1 loader next door: the engine is pure, so everything it needs is fetched
 * here and handed over whole, every query is scoped by `user_id`, and every query is bounded.
 * What differs is the shape — v2 wants trips, conditions, catches, offerings and sessions as
 * separate arrays and builds its own exposure from them, rather than v1's pre-joined hour rows.
 */

/** Ceiling on trips per run. The brief measured ~210ms at 300 trips; a thousand is far past any
 * real angler and still well inside the CPU limit set on the consumer. */
export const MAX_TRIPS_PER_USER = 1_000

/** Catches are bounded off the trip ceiling rather than independently: a catch without a trip is
 * not exposure, so there is no point loading more than the trips could hold. */
const CATCHES_PER_TRIP = 200

/** Completed trips only. An open trip has no `ended_at`, so it has no hour buckets and no
 * exposure; counting its fish against nothing would invent a rate. Planned trips never happened. */
const TRIPS_SQL = `
  SELECT id, water_body_id, started_at, ended_at, effort_source, target_species
  FROM trips
  WHERE user_id = ? AND deleted_at IS NULL AND ended_at IS NOT NULL AND planned = 0
  ORDER BY started_at DESC
  LIMIT ?`

/** Trip-hour rows only: `catch_id IS NULL` is what separates an hour of exposure from the
 * per-catch snapshot enrichment also writes. Feeding the per-catch rows in would double-count the
 * hours that happened to produce fish, which is the exact bias an exposure denominator exists to
 * remove. */
const CONDITIONS_SQL = `
  SELECT c.trip_id, c.hour_bucket, c.pressure_trend, c.cloud_pct, c.wind_kph, c.air_temp_c,
         c.water_temp_c, c.water_temp_delta_72h_c, c.precip_prev_48h_mm, c.discharge_cms,
         c.discharge_delta_24h_pct, c.moon_phase, c.minutes_from_sunrise, c.minutes_to_sunset,
         c.season
  FROM conditions c
  JOIN trips t ON t.id = c.trip_id AND t.user_id = c.user_id
  WHERE c.user_id = ? AND c.catch_id IS NULL AND c.trip_id IS NOT NULL AND c.hour_bucket IS NOT NULL
    AND t.deleted_at IS NULL AND t.ended_at IS NOT NULL AND t.planned = 0
  ORDER BY c.hour_bucket DESC
  LIMIT ?`

const CATCHES_SQL = `
  SELECT ca.id, ca.trip_id, ca.caught_at, ca.lure_id, ca.species, ca.length_mm
  FROM catches ca
  JOIN trips t ON t.id = ca.trip_id AND t.user_id = ca.user_id
  WHERE ca.user_id = ? AND ca.deleted_at IS NULL AND t.deleted_at IS NULL
    AND t.ended_at IS NOT NULL AND t.planned = 0
  ORDER BY ca.caught_at DESC
  LIMIT ?`

/** Retired lures are still loaded. A pattern about a lure the angler has since retired is still a
 * true statement about the season it came from, and dropping it would rewrite history. */
const LURES_SQL = `SELECT id, family, color FROM lures WHERE user_id = ? AND deleted_at IS NULL LIMIT ?`

const SESSIONS_SQL = `
  SELECT s.trip_id, s.lure_id, s.start_at, s.end_at, s.source
  FROM offering_sessions s
  JOIN trips t ON t.id = s.trip_id AND t.user_id = s.user_id
  WHERE s.user_id = ? AND s.deleted_at IS NULL AND t.deleted_at IS NULL
    AND t.ended_at IS NOT NULL AND t.planned = 0
  ORDER BY s.start_at
  LIMIT ?`

const PAUSES_SQL = `
  SELECT p.trip_id, p.start_at, p.end_at
  FROM trip_pauses p
  JOIN trips t ON t.id = p.trip_id AND t.user_id = p.user_id
  WHERE p.user_id = ? AND p.deleted_at IS NULL AND t.deleted_at IS NULL
  ORDER BY p.start_at
  LIMIT ?`

/** The lifecycle state that survives between runs. Without it every finding would read as
 * "discovered today" on every run, which is the one thing the record exists to prevent. */
const RECORDS_SQL = `SELECT record_json FROM pattern_findings WHERE user_id = ? LIMIT ?`

const HYPOTHESES_SQL = `
  SELECT id, dimension, bucket, scope, outcome, expectation, created_at
  FROM hypotheses
  WHERE user_id = ? AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT ?`

const SEASONS: ReadonlySet<string> = new Set(['spring', 'summer', 'fall', 'winter'])

/** D1 stores season as free text. Anything that is not one of the four is an unmeasured
 * dimension, not a fifth season. */
function season(value: string | null): Season | null {
  return value !== null && SEASONS.has(value) ? (value as Season) : null
}

const EFFORT_SOURCES: ReadonlySet<string> = new Set(['timer', 'manual', 'reconstructed'])

/** `effort_source` is NOT NULL with a default, so this only fires on a value written by something
 * other than the API — and an unrecognised one reads as `manual`, the most cautious of the three
 * for evidence quality. */
function effortSource(value: string | null): EffortSource {
  return value !== null && EFFORT_SOURCES.has(value) ? (value as EffortSource) : 'manual'
}

interface TripRow {
  id: string
  water_body_id: string | null
  started_at: number
  ended_at: number
  effort_source: string | null
  target_species: string | null
}

interface ConditionRow {
  trip_id: string
  hour_bucket: number
  pressure_trend: 'falling' | 'stable' | 'rising' | null
  cloud_pct: number | null
  wind_kph: number | null
  air_temp_c: number | null
  water_temp_c: number | null
  water_temp_delta_72h_c: number | null
  precip_prev_48h_mm: number | null
  discharge_cms: number | null
  discharge_delta_24h_pct: number | null
  moon_phase: number | null
  minutes_from_sunrise: number | null
  minutes_to_sunset: number | null
  season: string | null
}

interface CatchRow {
  id: string
  trip_id: string
  caught_at: number
  lure_id: string | null
  species: string
  length_mm: number | null
}

interface SessionRow {
  trip_id: string
  lure_id: string
  start_at: number
  end_at: number | null
  source: string
}

interface PauseRow {
  trip_id: string
  start_at: number
  end_at: number
}

interface HypothesisRow {
  id: string
  dimension: string
  bucket: string
  scope: string
  outcome: string
  expectation: string
  created_at: number
}

const HOUR_MS = 60 * 60 * 1000

/** A day long enough to cover the 48h trip ceiling, so the hour query cannot truncate a trip. */
const MAX_HOURS_PER_TRIP = 48

/**
 * Everything the engine reads, in one pass.
 *
 * `now` is injected rather than read here, because the engine is deterministic and the tests rely
 * on it: the same rows and the same clock must always produce the same findings.
 */
export async function loadEngineInput(
  db: D1Database,
  userId: string,
  now: number,
  limit: number = MAX_TRIPS_PER_USER,
): Promise<EngineInput> {
  const catchLimit = limit * CATCHES_PER_TRIP
  const [trips, conditions, catches, lures, sessions, pauses, records, hypotheses] = await Promise.all([
    db.prepare(TRIPS_SQL).bind(userId, limit).all<TripRow>(),
    db.prepare(CONDITIONS_SQL).bind(userId, limit * MAX_HOURS_PER_TRIP).all<ConditionRow>(),
    db.prepare(CATCHES_SQL).bind(userId, catchLimit).all<CatchRow>(),
    db.prepare(LURES_SQL).bind(userId, limit).all<OfferingInput>(),
    db.prepare(SESSIONS_SQL).bind(userId, catchLimit).all<SessionRow>(),
    db.prepare(PAUSES_SQL).bind(userId, catchLimit).all<PauseRow>(),
    db.prepare(RECORDS_SQL).bind(userId, catchLimit).all<{ record_json: string }>(),
    db.prepare(HYPOTHESES_SQL).bind(userId, limit).all<HypothesisRow>(),
  ])

  // Pauses ride on the trip they belong to. A pause whose trip did not survive the trip query
  // (deleted, open, planned, or past the ceiling) has nothing to attach to, and is dropped with it
  // rather than left to shorten a trip that is not in this run.
  const pausesByTrip = new Map<string, { start: number; end: number }[]>()
  for (const p of pauses.results) {
    const list = pausesByTrip.get(p.trip_id)
    if (list) list.push({ start: p.start_at, end: p.end_at })
    else pausesByTrip.set(p.trip_id, [{ start: p.start_at, end: p.end_at }])
  }

  const tripInputs: TripInput[] = trips.results.map((t) => ({
    id: t.id,
    waterBodyId: t.water_body_id,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    effortSource: effortSource(t.effort_source),
    targetSpecies: t.target_species,
    pauses: pausesByTrip.get(t.id) ?? [],
  }))

  const conditionInputs: ConditionSlice[] = conditions.results.map((c) => ({
    tripId: c.trip_id,
    start: c.hour_bucket * HOUR_MS,
    end: c.hour_bucket * HOUR_MS + HOUR_MS,
    features: {
      pressureTrend: c.pressure_trend,
      cloudPct: c.cloud_pct,
      windKph: c.wind_kph,
      airTempC: c.air_temp_c,
      waterTempC: c.water_temp_c,
      waterTempDelta72hC: c.water_temp_delta_72h_c,
      precipPrev48hMm: c.precip_prev_48h_mm,
      dischargeCms: c.discharge_cms,
      dischargeDelta24hPct: c.discharge_delta_24h_pct,
      moonPhase: c.moon_phase,
      minutesFromSunrise: c.minutes_from_sunrise,
      minutesToSunset: c.minutes_to_sunset,
      season: season(c.season),
    },
  }))

  const catchInputs: CatchInput[] = catches.results.map((k) => ({
    id: k.id,
    tripId: k.trip_id,
    caughtAt: k.caught_at,
    offeringId: k.lure_id,
    species: k.species,
    lengthMm: k.length_mm,
  }))

  const sessionInputs: OfferingSessionInput[] = sessions.results.map((s) => ({
    tripId: s.trip_id,
    offeringId: s.lure_id,
    start: s.start_at,
    end: s.end_at,
    // Anything not written as a tap is an interval something inferred, and ADR-0017 scores
    // estimated exposure down so it can never reach `solid` on its own.
    source: s.source === 'tap' ? 'tap' : 'estimated',
  }))

  const hypothesisInputs: HypothesisInput[] = hypotheses.results.map((h) => ({
    id: h.id,
    dimension: h.dimension,
    bucket: h.bucket,
    scopeId: h.scope,
    outcome: h.outcome as HypothesisInput['outcome'],
    expectation: h.expectation as HypothesisInput['expectation'],
    createdAt: h.created_at,
  }))

  return {
    userId,
    now,
    trips: tripInputs,
    conditions: conditionInputs,
    catches: catchInputs,
    offerings: lures.results,
    offeringSessions: sessionInputs,
    previousRecords: parseRecords(records.results),
    hypotheses: hypothesisInputs,
  }
}

/**
 * `record_json` is written by this worker and read back by it, so a parse failure means the row is
 * corrupt rather than that the angler did something unusual. Dropping the record loses that
 * finding's history — it will read as newly discovered — which is worse than ideal and far better
 * than failing the run and leaving every other finding stale.
 */
function parseRecords(rows: { record_json: string }[]): FindingRecord[] {
  const out: FindingRecord[] = []
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.record_json) as FindingRecord)
    } catch (err) {
      console.error('cron: dropping unparseable finding record', err)
    }
  }
  return out
}
