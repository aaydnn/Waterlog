import { describe, expect, it } from 'vitest'
import {
  catchSchema,
  conditionsSchema,
  enrichJobSchema,
  hypothesisInputSchema,
  hypothesisSchema,
  lureSchema,
  offeringSessionSchema,
  patternCacheRowSchema,
  patternFindingRowSchema,
  patternJobSchema,
  patternRunRowSchema,
  tripPauseSchema,
  tripSchema,
  userSchema,
  waterBodySchema,
} from './index'

// Round-trip: seed-shaped rows (migrations/seed/seed.sql) parse through each
// schema and come back unchanged.
describe('schema round-trips against seed-shaped rows', () => {
  it('users', () => {
    const row = {
      id: 'usr_demo01',
      email: 'demo@waterlog.app',
      display_name: 'Demo Angler',
      home_lat: 36.0331,
      home_lng: -86.7828,
      units: 'imperial',
      tier: 'free',
      stripe_customer_id: null,
      created_at: 1780315200000,
      updated_at: 1780315200000,
      deleted_at: null,
    }
    expect(userSchema.parse(row)).toEqual(row)
  })

  it('water_bodies', () => {
    const row = {
      id: 'wb_caney01',
      user_id: 'usr_demo01',
      name: 'Caney Fork River',
      kind: 'river',
      centroid_lat: 36.102,
      centroid_lng: -85.7905,
      usgs_gauge_id: '03421000',
      nwps_gauge_id: null,
      is_home: 0,
      created_at: 1780315200000,
      updated_at: 1780315200000,
      deleted_at: null,
    }
    expect(waterBodySchema.parse(row)).toEqual(row)
  })

  it('lures', () => {
    const row = {
      id: 'lur_spin01',
      user_id: 'usr_demo01',
      name: 'War Eagle Spinnerbait 3/8 oz',
      family: 'spinnerbait',
      color: 'chartreuse',
      cost_cents: 899,
      retired_at: null,
      created_at: 1780315200000,
      updated_at: 1780315200000,
      deleted_at: null,
    }
    expect(lureSchema.parse(row)).toEqual(row)
  })

  it('trips (including the skunk trip)', () => {
    const skunk = {
      id: 'trp_00003',
      user_id: 'usr_demo01',
      water_body_id: 'wb_percy01',
      started_at: 1783162800000,
      ended_at: 1783170000000,
      auto_created: 0,
      planned: 1,
      notes: 'July 4th, bluebird sky, boat traffic everywhere. Skunked.',
      water_temp_c: 27.2,
      client_id: null,
      effort_source: 'manual',
      target_species: null,
      lesson_json: null,
      created_at: 1783162800000,
      updated_at: 1783170000000,
      deleted_at: null,
    }
    expect(tripSchema.parse(skunk)).toEqual(skunk)
  })

  it('catches', () => {
    const row = {
      id: 'cat_00003',
      user_id: 'usr_demo01',
      trip_id: 'trp_00001',
      lure_id: 'lur_spin01',
      species: 'largemouth_bass',
      caught_at: 1780746900000,
      lat: 36.0602,
      lng: -86.5531,
      photo_key: null,
      length_mm: 442,
      weight_g: 1450,
      depth_m: 1.8,
      released: 1,
      notes: 'Windblown point, slow roll.',
      client_id: '01JX00000000000000000003',
      enrich_status: 'pending',
      created_at: 1780746900000,
      updated_at: 1780746900000,
      deleted_at: null,
    }
    expect(catchSchema.parse(row)).toEqual(row)
  })

  it('conditions', () => {
    const row = {
      id: 'cnd_00001',
      user_id: 'usr_demo01',
      catch_id: 'cat_00003',
      trip_id: null,
      hour_bucket: null,
      air_temp_c: 22.5,
      cloud_pct: 40,
      wind_kph: 12,
      precip_mm: 0,
      pressure_hpa: 1016.2,
      pressure_trend: 'falling',
      moon_phase: 0.73,
      minutes_from_sunrise: 55,
      water_temp_c: 24.1,
      water_temp_source: 'gauge',
      discharge_cms: null,
      pool_elevation_ft: null,
      tailwater_ft: null,
      minutes_to_sunset: -35,
      water_temp_delta_72h_c: 1.4,
      precip_prev_48h_mm: 6.2,
      discharge_delta_24h_pct: null,
      season: 'summer',
      source_meta: '{"weather":"open-meteo"}',
      created_at: 1780746900000,
    }
    expect(conditionsSchema.parse(row)).toEqual(row)
  })

  it('pattern_cache', () => {
    const row = {
      id: 'pat_00001',
      user_id: 'usr_demo01',
      scope: 'all',
      dimension: 'lure_family',
      bucket: 'spinnerbait',
      catches: 3,
      hours: 8.5,
      rate: 0.35,
      baseline_rate: 0.2,
      multiplier: 1.75,
      confidence: 'early',
      // Three catches across two outings: enough to be an early signal, not enough to be more
      // (packet §08's distinct-trip minimums).
      trips: 2,
      computed_at: 1783170000000,
    }
    expect(patternCacheRowSchema.parse(row)).toEqual(row)
  })

  it('enrich jobs (discriminated union)', () => {
    expect(enrichJobSchema.parse({ type: 'catch', catch_id: 'cat_00003' })).toEqual({
      type: 'catch',
      catch_id: 'cat_00003',
    })
    expect(
      enrichJobSchema.parse({ type: 'trip_hours', trip_id: 'trp_00001', hour_buckets: [485712, 485713] }),
    ).toEqual({ type: 'trip_hours', trip_id: 'trp_00001', hour_buckets: [485712, 485713] })
    expect(enrichJobSchema.safeParse({ type: 'catch', trip_id: 'trp_00001' }).success).toBe(false)
    expect(enrichJobSchema.safeParse({ type: 'unknown' }).success).toBe(false)
  })

  it('rejects out-of-enum values', () => {
    expect(
      catchSchema.safeParse({
        id: 'x',
        user_id: 'x',
        trip_id: 'x',
        lure_id: null,
        species: 'largemouth_bass',
        caught_at: 0,
        lat: null,
        lng: null,
        photo_key: null,
        length_mm: null,
        weight_g: null,
        depth_m: null,
        released: null,
        notes: null,
        client_id: null,
        enrich_status: 'enriched', // not a valid enrich_status
        created_at: 0,
        updated_at: 0,
        deleted_at: null,
      }).success,
    ).toBe(false)
  })
})

// Pattern engine v2 (ADR-0017, migration 0009). Same round-trip contract as the tables above,
// plus the two cases the new columns exist to express: an open tie-on interval, and a finding
// that is computed but not surfaced.
describe('pattern engine v2 rows', () => {
  it('offering_sessions, including an interval still open', () => {
    const row = {
      id: 'ofs_00001',
      user_id: 'usr_demo01',
      trip_id: 'trp_00001',
      lure_id: 'lur_00001',
      start_at: 1783162800000,
      end_at: null, // runs until the next tie-on or the trip's end
      source: 'tap',
      client_id: '01JX00000000000000000010',
      created_at: 1783162800000,
      updated_at: 1783162800000,
      deleted_at: null,
    }
    expect(offeringSessionSchema.parse(row)).toEqual(row)
  })

  it('rejects an offering session source it does not know', () => {
    expect(
      offeringSessionSchema.safeParse({
        id: 'ofs_00002',
        user_id: 'usr_demo01',
        trip_id: 'trp_00001',
        lure_id: 'lur_00001',
        start_at: 0,
        end_at: null,
        source: 'guessed', // only 'tap' | 'estimated'
        client_id: null,
        created_at: 0,
        updated_at: 0,
        deleted_at: null,
      }).success,
    ).toBe(false)
  })

  it('trip_pauses', () => {
    const row = {
      id: 'tps_00001',
      user_id: 'usr_demo01',
      trip_id: 'trp_00001',
      start_at: 1783166400000,
      end_at: 1783168200000,
      client_id: '01JX00000000000000000011',
      created_at: 1783166400000,
      updated_at: 1783168200000,
      deleted_at: null,
    }
    expect(tripPauseSchema.parse(row)).toEqual(row)
  })

  it('pattern_findings: computed but not surfaced keeps its record', () => {
    const row = {
      user_id: 'usr_demo01',
      key: 'all::all::pressure_trend::falling',
      scope: 'all',
      outcome: 'all',
      dimension: 'pressure_trend',
      bucket: 'falling',
      direction: 'positive',
      tier: null, // not surfaced this run
      lifecycle: 'weakening',
      multiplier: 1.62, // shrunk, never the raw ratio
      finding_json: null, // null whenever tier is null
      record_json: '{"history":[{"reason":"recent_decline"}]}', // never null: it is the memory
      engine_version: '2.0.0',
      computed_at: 1783170000000,
    }
    expect(patternFindingRowSchema.parse(row)).toEqual(row)
  })

  it('rejects a lifecycle state that is not one of the six', () => {
    expect(
      patternFindingRowSchema.safeParse({
        user_id: 'usr_demo01',
        key: 'all::all::sky::overcast',
        scope: 'all',
        outcome: 'all',
        dimension: 'sky',
        bucket: 'overcast',
        direction: 'positive',
        tier: 'solid',
        lifecycle: 'proven', // not a lifecycle state
        multiplier: 2.1,
        finding_json: '{}',
        record_json: '{}',
        engine_version: '2.0.0',
        computed_at: 0,
      }).success,
    ).toBe(false)
  })

  it('hypotheses and the input that creates one', () => {
    const row = {
      id: 'hyp_00001',
      user_id: 'usr_demo01',
      statement: 'I catch more on chartreuse when the water is stained.',
      dimension: 'lure_color',
      bucket: 'chartreuse',
      scope: 'all',
      outcome: 'all',
      expectation: 'better',
      result_json: null, // not yet judged
      created_at: 1783162800000,
      updated_at: 1783162800000,
      deleted_at: null,
    }
    expect(hypothesisSchema.parse(row)).toEqual(row)

    // scope and outcome default to 'all' so the picker can omit them.
    expect(
      hypothesisInputSchema.parse({
        statement: 'Topwater dies after sunrise.',
        dimension: 'time_block',
        bucket: 'early_morning',
        expectation: 'worse',
      }),
    ).toEqual({
      statement: 'Topwater dies after sunrise.',
      dimension: 'time_block',
      bucket: 'early_morning',
      scope: 'all',
      outcome: 'all',
      expectation: 'worse',
    })
  })

  it('pattern_runs carries v2 output beside the retired v1 chunking columns', () => {
    const row = {
      user_id: 'usr_demo01',
      completed_at: 1783170000000,
      cursor: null, // vestigial: v2 runs an angler to completion (ADR-0017)
      pattern_count: 4,
      unattributed_catches: 1,
      updated_at: 1783170000000,
      result_json: '{"families":[],"experiments":[]}',
      engine_version: '2.0.0',
      computed_at: 1783170000000,
    }
    expect(patternRunRowSchema.parse(row)).toEqual(row)
  })

  it('a v1 pattern job still parses, and defaults the v2 fields', () => {
    expect(patternJobSchema.parse({ user_id: 'usr_demo01' })).toEqual({
      user_id: 'usr_demo01',
      cursor: null,
      trip_id: null,
    })
  })
})
