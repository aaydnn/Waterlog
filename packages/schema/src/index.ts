// Shared payload shapes for WaterLog: one Zod schema per D1 table
// (migrations/0001_initial_schema.sql). Both the web client and the workers
// import from this package — payload shapes are never defined anywhere else.
//
// Conventions mirroring the storage layer:
// - Timestamps are integer unix epoch milliseconds.
// - SQLite has no booleans: flag columns are 0 | 1 (`sqliteBool`).
// - NULLable columns are `.nullable()`; enum-like TEXT columns are z.enum.
import { z } from 'zod'
export { usgsPageSchema, usgsSeriesFeatureSchema, usgsReadingFeatureSchema } from './usgs'
export { nwpsGaugeSchema, nwpsStageflowSchema } from './nwps'

export const SCHEMA_VERSION = 1

const sqliteBool = z.union([z.literal(0), z.literal(1)])
const timestamp = z.number().int()

const baseRow = {
  id: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: timestamp.nullable(),
}

export const unitsSchema = z.enum(['imperial', 'metric'])
export const tierSchema = z.enum(['free', 'pro'])

export const userSchema = z.object({
  ...baseRow,
  email: z.string().email(),
  display_name: z.string().nullable(),
  home_lat: z.number().nullable(),
  home_lng: z.number().nullable(),
  units: unitsSchema,
  tier: tierSchema,
  stripe_customer_id: z.string().nullable(),
})
export type User = z.infer<typeof userSchema>

export const waterBodyKindSchema = z.enum(['lake', 'river', 'pond', 'reservoir', 'saltwater'])
/** Whether a water flows decides whether USGS discharge means anything on it (ADR-0010). */
export type WaterBodyKind = z.infer<typeof waterBodyKindSchema>

export const waterBodySchema = z.object({
  ...baseRow,
  user_id: z.string(),
  name: z.string(),
  kind: waterBodyKindSchema.nullable(),
  centroid_lat: z.number().nullable(),
  centroid_lng: z.number().nullable(),
  usgs_gauge_id: z.string().nullable(),
  // NOAA NWPS pool-gauge handle (e.g. 'NRST1'). Set explicitly, never by proximity (ADR-0008).
  nwps_gauge_id: z.string().nullable(),
  is_home: sqliteBool,
})
export type WaterBody = z.infer<typeof waterBodySchema>

export const lureFamilySchema = z.enum([
  'spinnerbait',
  'crankbait',
  'soft_plastic',
  'jig',
  'topwater',
  'live_bait',
  'fly',
  'other',
])

export const lureSchema = z.object({
  ...baseRow,
  user_id: z.string(),
  name: z.string(),
  family: lureFamilySchema.nullable(),
  color: z.string().nullable(),
  cost_cents: z.number().int().nullable(),
  retired_at: timestamp.nullable(),
})
export type Lure = z.infer<typeof lureSchema>

/**
 * How a trip's start and end were captured (ADR-0017). `timer` was running while it happened,
 * `manual` was typed in afterwards, `reconstructed` was inferred — F10 camera-roll imports and
 * orphan auto-created trips. The engine scores exposure quality from this, so a reconstructed
 * trip can raise a hypothesis but never confirm one on its own.
 */
export const effortSourceSchema = z.enum(['timer', 'manual', 'reconstructed'])
export type EffortSource = z.infer<typeof effortSourceSchema>

export const tripSchema = z.object({
  ...baseRow,
  user_id: z.string(),
  water_body_id: z.string().nullable(),
  started_at: timestamp,
  ended_at: timestamp.nullable(), // null = active
  auto_created: sqliteBool,
  planned: sqliteBool,
  notes: z.string().nullable(),
  // Angler-measured surface temp for the outing; beats any model (ADR-0008).
  water_temp_c: z.number().nullable(),
  client_id: z.string().nullable(), // client ULID: offline dedupe, idempotent sync
  // How the trip's clock was established, which is how far the exposure denominator can be
  // trusted. Feeds evidence quality in the v2 engine (ADR-0017).
  effort_source: effortSourceSchema,
  // Species slug, 'mixed', or null for "didn't say". A bass trip that caught no bass is not the
  // same observation as a panfish trip that caught six.
  target_species: z.string().nullable(),
  // Post-trip lesson from the engine's summarizeTrip(), written by the pattern queue consumer.
  // Opaque JSON here: the shape belongs to @waterlog/pattern-engine, and the row schema mirrors
  // the D1 column, which is TEXT.
  lesson_json: z.string().nullable(),
})
export type Trip = z.infer<typeof tripSchema>

export const enrichStatusSchema = z.enum(['pending', 'done', 'partial', 'failed'])

export const catchSchema = z.object({
  ...baseRow,
  user_id: z.string(),
  trip_id: z.string(),
  lure_id: z.string().nullable(),
  species: z.string(),
  caught_at: timestamp,
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  photo_key: z.string().nullable(),
  length_mm: z.number().int().nullable(),
  weight_g: z.number().int().nullable(),
  depth_m: z.number().nullable(),
  released: sqliteBool.nullable(),
  notes: z.string().nullable(),
  client_id: z.string().nullable(), // client ULID: offline dedupe, idempotent sync
  enrich_status: enrichStatusSchema,
})
export type Catch = z.infer<typeof catchSchema>

export const pressureTrendSchema = z.enum(['falling', 'stable', 'rising'])

// Where conditions.water_temp_c came from, so Epic 4 can weight a measurement above a guess.
export const waterTempSourceSchema = z.enum(['measured', 'gauge', 'modeled'])

export const conditionsSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  catch_id: z.string().nullable(),
  trip_id: z.string().nullable(),
  hour_bucket: z.number().int().nullable(),
  air_temp_c: z.number().nullable(),
  cloud_pct: z.number().nullable(),
  wind_kph: z.number().nullable(),
  precip_mm: z.number().nullable(),
  pressure_hpa: z.number().nullable(),
  pressure_trend: pressureTrendSchema.nullable(),
  moon_phase: z.number().min(0).max(1).nullable(), // 0..1 (0 = new)
  minutes_from_sunrise: z.number().int().nullable(),
  water_temp_c: z.number().nullable(),
  water_temp_source: waterTempSourceSchema.nullable(),
  discharge_cms: z.number().nullable(),
  pool_elevation_ft: z.number().nullable(), // reservoir level (NWPS)
  tailwater_ft: z.number().nullable(),      // below-dam stage: a generation indicator
  // Trajectory and real-sunset enrichment (ADR-0017). All best-effort: a missing value is an
  // unmeasured dimension, never a zero.
  minutes_to_sunset: z.number().int().nullable(),   // negative = after sunset
  water_temp_delta_72h_c: z.number().nullable(),    // gauge only; air temp is not a substitute
  precip_prev_48h_mm: z.number().nullable(),        // today's fish are fed by yesterday's rain
  discharge_delta_24h_pct: z.number().nullable(),   // null when either reading or the base is 0
  season: z.string().nullable(),
  source_meta: z.string().nullable(),
  created_at: timestamp,
})
export type Conditions = z.infer<typeof conditionsSchema>

export const confidenceSchema = z.enum(['early', 'promising', 'solid'])

// Epic 2: the ENRICH_QUEUE message shape, shared by the api (producer) and enrich (consumer)
// workers so neither side can drift from the other.
export const enrichCatchJobSchema = z.object({
  type: z.literal('catch'),
  catch_id: z.string(),
})
export const enrichTripHoursJobSchema = z.object({
  type: z.literal('trip_hours'),
  trip_id: z.string(),
  hour_buckets: z.array(z.number().int()),
})
export const enrichJobSchema = z.discriminatedUnion('type', [
  enrichCatchJobSchema,
  enrichTripHoursJobSchema,
])
export type EnrichJob = z.infer<typeof enrichJobSchema>

// Epic 4: the PATTERN_QUEUE message shape. The nightly cron enqueues one job per angler and the
// consumer computes one angler per message, which is what gives each of them their own CPU budget
// and their own retry. `cursor` carries the scope a budgeted-out run stopped at.
//
// v2 (ADR-0017) runs each angler to completion, so `cursor` is vestigial there and stays only so
// a v1 message already on the queue still parses during the transition. `trip_id` is set by the
// post-trip run, which computes the trip lesson for the trip that just ended.
export const patternJobSchema = z.object({
  user_id: z.string(),
  cursor: z.string().nullable().default(null),
  trip_id: z.string().nullable().default(null),
})
export type PatternJob = z.infer<typeof patternJobSchema>

/**
 * A v2 pattern-engine job (ADR-0017). One angler per message on the `pattern-engine` queue,
 * separate from v1's `waterlog-patterns` so a slow v2 run cannot delay a v1 recompute.
 *
 * No `cursor`: v1 chunks a run against a row budget and resumes, but v2 measures roughly 60ms at
 * 40 trips and 210ms at 300, so it runs to completion inside one invocation with `limits.cpu_ms`
 * as the backstop. `trip_id` names the trip when a run follows one ending, and is null on the
 * nightly sweep.
 */
export const patternEngineJobSchema = z.object({
  user_id: z.string(),
  trip_id: z.string().nullable().default(null),
})
export type PatternEngineJob = z.infer<typeof patternEngineJobSchema>

export const patternCacheRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  scope: z.string(), // 'all' | water_body_id
  dimension: z.string(),
  bucket: z.string(),
  catches: z.number().int(),
  hours: z.number(),
  rate: z.number(),
  baseline_rate: z.number(),
  multiplier: z.number(),
  confidence: confidenceSchema,
  /** Distinct trips behind the pattern: the anti-pseudo-replication guard the confidence tiers
   * are built on, and what the card's sample-size footer shows (migration 0008). */
  trips: z.number().int(),
  computed_at: timestamp,
})
export type PatternCacheRow = z.infer<typeof patternCacheRowSchema>

// Epic 3: the journal (F3) and free-tier stats (F4) responses. Read-only projections — the
// server joins the names a card needs so the client never has to fan out per row.
export const journalEntrySchema = z.object({
  id: z.string(),
  caught_at: timestamp,
  species: z.string(),
  photo_key: z.string().nullable(),
  length_mm: z.number().int().nullable(),
  weight_g: z.number().int().nullable(),
  released: sqliteBool.nullable(),
  notes: z.string().nullable(),
  enrich_status: enrichStatusSchema,
  lure_id: z.string().nullable(),
  lure_name: z.string().nullable(),
  trip_id: z.string(),
  water_body_id: z.string().nullable(),
  water_body_name: z.string().nullable(),
})
export type JournalEntry = z.infer<typeof journalEntrySchema>

export const journalPageSchema = z.object({
  entries: z.array(journalEntrySchema),
  /** Opaque keyset cursor; null when this is the last page. */
  next_cursor: z.string().nullable(),
})
export type JournalPage = z.infer<typeof journalPageSchema>

/** Everything F3's detail view shows for one catch, including the enriched conditions row. */
export const catchDetailSchema = z.object({
  catch: catchSchema,
  trip: tripSchema.nullable(),
  water_body: waterBodySchema.nullable(),
  lure: lureSchema.nullable(),
  conditions: conditionsSchema.nullable(),
})
export type CatchDetail = z.infer<typeof catchDetailSchema>

// F4, free tier: totals and simple breakdowns only. Condition correlations are the Pro pattern
// engine's job (Epic 4) and deliberately absent here.
export const statsSchema = z.object({
  totals: z.object({
    catches: z.number().int(),
    trips: z.number().int(),
    /** Ended trips only — an open trip has no duration yet. */
    hours_on_water: z.number(),
    /** Ended trips with zero catches: the denominator that makes rates honest (packet §08). */
    skunked_trips: z.number().int(),
    species: z.number().int(),
    waters: z.number().int(),
  }),
  by_species: z.array(z.object({ species: z.string(), catches: z.number().int() })),
  by_month: z.array(
    z.object({ month: z.string(), catches: z.number().int(), trips: z.number().int() }),
  ),
  by_water: z.array(
    z.object({
      water_body_id: z.string().nullable(),
      water_body_name: z.string().nullable(),
      catches: z.number().int(),
      trips: z.number().int(),
    }),
  ),
})
export type Stats = z.infer<typeof statsSchema>

// Epic 4: the pattern feed (F6). `pattern_cache` stores a dimension and a bucket, never prose —
// the sentence on the card is rendered from those by @waterlog/patterns, so the vocabulary has
// one home and the cache stays exactly the table packet §07 defines.
export const patternCardSchema = z.object({
  id: z.string(),
  scope: z.string(), // 'all' | water_body_id
  scope_name: z.string().nullable(), // the water's name, joined for the card
  dimension: z.string(),
  bucket: z.string(),
  catches: z.number().int(),
  hours: z.number(),
  rate: z.number(),
  baseline_rate: z.number(),
  multiplier: z.number(),
  confidence: confidenceSchema,
  trips: z.number().int(),
  computed_at: timestamp,
})
export type PatternCard = z.infer<typeof patternCardSchema>

/**
 * What a free angler is told about a pattern they have not paid to see: that it exists, how well
 * replicated it is, and which kind of thing it is about. Never the bucket, the multiplier or the
 * counts.
 *
 * The blur is a rendering of this, not a rendering of a full card with a filter over it. Packet
 * §09 says the tease must be true, and it is: the count is real and computed from this angler's
 * own fishing. It also has to stay a tease, and a card blurred only in CSS is one devtools tab
 * away from being the product (ADR-0016).
 */
export const patternTeaserSchema = z.object({
  id: z.string(),
  dimension_label: z.string(), // 'your lure colour', 'pressure', 'time of day'
  confidence: confidenceSchema,
})
export type PatternTeaser = z.infer<typeof patternTeaserSchema>

export const patternFeedSchema = z.discriminatedUnion('tier', [
  z.object({
    tier: z.literal('pro'),
    patterns: z.array(patternCardSchema),
    /** Catches no rate could count: their trip is still open, or its hours never enriched. */
    unattributed_catches: z.number().int(),
    /** Hours until the engine has a baseline to divide by, or 0 once it does. */
    hours_until_baseline: z.number(),
    computed_at: timestamp.nullable(), // null = never yet computed
  }),
  z.object({
    tier: z.literal('free'),
    /** The real number found in this angler's own data. The tease must be true. */
    total: z.number().int(),
    teasers: z.array(patternTeaserSchema),
    hours_until_baseline: z.number(),
    computed_at: timestamp.nullable(),
  }),
])
export type PatternFeed = z.infer<typeof patternFeedSchema>

// Epic 4/5: Web Push (VAPID) subscriptions. One row per browser that opted in; the first-pattern
// push (§09 flow 3) is the first thing to use it and the briefing push reuses it.
export const pushSubscriptionSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
  created_at: timestamp,
})
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>

/** What the client sends after `PushManager.subscribe()` resolves. */
export const pushSubscriptionInputSchema = z.object({
  endpoint: z.string().url().max(2048),
  p256dh: z.string().min(1).max(256),
  auth: z.string().min(1).max(256),
})
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>

// ─────────────────────────── Pattern engine v2 (ADR-0017) ───────────────────────────
// Migration 0010. These are the rows the v2 engine reads and writes; the engine's own types
// (Finding, FindingRecord, HypothesisResult, EngineResult) live in @waterlog/pattern-engine and
// reach D1 as JSON in the `*_json` columns below. The row schema mirrors the column, so those
// stay `z.string()` here rather than being re-described — a shape defined twice is a shape that
// drifts.

/**
 * A tie-on interval: what was actually in the water, and when (ADR-0017). This is the measurement
 * that replaces ADR-0015's apportioned exposure wherever it exists.
 *
 * `end_at` null means the session runs until the next tie-on on the same trip, or the trip's end.
 * The engine closes it, so the client never has to — a client that must remember to close an
 * interval will eventually ship one that never closes.
 */
export const offeringSessionSourceSchema = z.enum(['tap', 'estimated'])
export type OfferingSessionSource = z.infer<typeof offeringSessionSourceSchema>

export const offeringSessionSchema = z.object({
  ...baseRow,
  user_id: z.string(),
  trip_id: z.string(),
  lure_id: z.string(),
  start_at: timestamp,
  end_at: timestamp.nullable(),
  source: offeringSessionSourceSchema,
  client_id: z.string().nullable(), // client ULID: same idempotent-sync contract as trips
})
export type OfferingSession = z.infer<typeof offeringSessionSchema>

/**
 * Non-fishing time inside a trip: the drive between spots, lunch, the hour spent re-rigging.
 * Without it a trip's exposure is wall-clock, which dilutes every rate measured on the trips
 * where the angler took a break — and those are disproportionately the long trips.
 */
export const tripPauseSchema = z.object({
  ...baseRow,
  user_id: z.string(),
  trip_id: z.string(),
  start_at: timestamp,
  end_at: timestamp,
  client_id: z.string().nullable(),
})
export type TripPause = z.infer<typeof tripPauseSchema>

/** Where a finding sits in its life, which is what the feed sorts and badges on (ADR-0017). */
export const findingLifecycleSchema = z.enum([
  'hypothesis',
  'emerging',
  'repeated',
  'confirmed',
  'weakening',
  'retired',
])
export type FindingLifecycle = z.infer<typeof findingLifecycleSchema>

export const findingDirectionSchema = z.enum(['positive', 'negative'])
export type FindingDirection = z.infer<typeof findingDirectionSchema>

/**
 * One finding per angler, holding its latest state. The two JSON columns are the point of the
 * table: `finding_json` is what the feed shows *this* run and is null when the finding exists but
 * is not currently surfaced, while `record_json` is the lifecycle state that survives between
 * runs. Losing `record_json` would reset every angler's history to "discovered today".
 */
export const patternFindingRowSchema = z.object({
  user_id: z.string(),
  key: z.string(), // scope::outcome::dimension::bucket
  scope: z.string(),
  outcome: z.string(),
  dimension: z.string(),
  bucket: z.string(),
  direction: findingDirectionSchema,
  tier: confidenceSchema.nullable(), // null = computed but not surfaced this run
  lifecycle: findingLifecycleSchema,
  multiplier: z.number(), // shrunk (ADR-0017), never the raw ratio
  finding_json: z.string().nullable(),
  record_json: z.string(),
  engine_version: z.string(),
  computed_at: timestamp,
})
export type PatternFindingRow = z.infer<typeof patternFindingRowSchema>

/**
 * An angler's own belief, tested against their own data. `statement` is their words and is
 * display-only; the engine reads the structured columns. A hypothesis is a standing question
 * rather than a discovered claim, which is why it is not a `pattern_findings` row.
 */
export const hypothesisExpectationSchema = z.enum(['better', 'worse', 'no_difference'])
export type HypothesisExpectation = z.infer<typeof hypothesisExpectationSchema>

export const hypothesisSchema = z.object({
  ...baseRow,
  user_id: z.string(),
  statement: z.string(),
  dimension: z.string(),
  bucket: z.string(),
  scope: z.string(),
  outcome: z.string(),
  expectation: hypothesisExpectationSchema,
  result_json: z.string().nullable(),
})
export type Hypothesis = z.infer<typeof hypothesisSchema>

/** What the client sends to record a belief. The structured picker supplies everything but the
 *  statement, which is free text purely so the card can quote the angler back to themselves. */
export const hypothesisInputSchema = z.object({
  statement: z.string().min(1).max(280),
  dimension: z.string().min(1).max(64),
  bucket: z.string().min(1).max(64),
  scope: z.string().min(1).max(64).default('all'),
  outcome: z.string().min(1).max(64).default('all'),
  expectation: hypothesisExpectationSchema,
})
export type HypothesisInput = z.infer<typeof hypothesisInputSchema>

/**
 * Run-level output that is not a finding: family metadata, profiles, experiments, questions and
 * data quality. Added to the `pattern_runs` row 0008 created, so the v1 chunking columns are
 * still present and nullable here (ADR-0017 retires them rather than dropping them).
 */
export const patternRunRowSchema = z.object({
  user_id: z.string(),
  completed_at: timestamp.nullable(),
  cursor: z.string().nullable(),
  pattern_count: z.number().int(),
  unattributed_catches: z.number().int(),
  updated_at: timestamp,
  result_json: z.string().nullable(),
  engine_version: z.string().nullable(),
  computed_at: timestamp.nullable(),
})
export type PatternRunRow = z.infer<typeof patternRunRowSchema>
