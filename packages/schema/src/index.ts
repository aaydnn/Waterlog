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
