import { describe, expect, it } from 'vitest'
import {
  catchSchema,
  conditionsSchema,
  lureSchema,
  patternCacheRowSchema,
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
      client_id: null,
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
      discharge_cms: null,
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
      computed_at: 1783170000000,
    }
    expect(patternCacheRowSchema.parse(row)).toEqual(row)
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
