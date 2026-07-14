CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  home_lat REAL, home_lng REAL,
  units TEXT NOT NULL DEFAULT 'imperial',      -- imperial | metric
  tier TEXT NOT NULL DEFAULT 'free',           -- free | pro
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE water_bodies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT,                                    -- lake | river | pond | reservoir | saltwater
  centroid_lat REAL, centroid_lng REAL,
  usgs_gauge_id TEXT,
  is_home INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE lures (                            -- generic "offering": lure, bait, or fly
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  family TEXT,                                  -- spinnerbait | crankbait | soft_plastic | jig | topwater | live_bait | fly | other
  color TEXT,                                   -- normalized color slug
  cost_cents INTEGER,
  retired_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  water_body_id TEXT REFERENCES water_bodies(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,                             -- null = active
  auto_created INTEGER NOT NULL DEFAULT 0,
  planned INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX idx_trips_user_time ON trips(user_id, started_at);
CREATE TABLE catches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  lure_id TEXT REFERENCES lures(id),
  species TEXT NOT NULL,
  caught_at INTEGER NOT NULL,
  lat REAL, lng REAL,
  photo_key TEXT,
  length_mm INTEGER, weight_g INTEGER,
  depth_m REAL,
  released INTEGER,
  notes TEXT,
  client_id TEXT UNIQUE,                        -- client ULID: offline dedupe, idempotent sync
  enrich_status TEXT NOT NULL DEFAULT 'pending',-- pending | done | partial | failed
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX idx_catches_user_time ON catches(user_id, caught_at);
CREATE INDEX idx_catches_trip ON catches(trip_id);
CREATE TABLE conditions (                       -- one row per catch AND one per trip-hour
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  catch_id TEXT REFERENCES catches(id),
  trip_id TEXT REFERENCES trips(id),
  hour_bucket INTEGER,
  air_temp_c REAL, cloud_pct REAL, wind_kph REAL, precip_mm REAL,
  pressure_hpa REAL, pressure_trend TEXT,       -- falling | stable | rising
  moon_phase REAL,                              -- 0..1 (0 = new)
  minutes_from_sunrise INTEGER,
  water_temp_c REAL, discharge_cms REAL,
  season TEXT,
  source_meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_conditions_catch ON conditions(catch_id);
CREATE INDEX idx_conditions_trip_hour ON conditions(trip_id, hour_bucket);
CREATE TABLE pattern_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,                          -- 'all' | water_body_id
  dimension TEXT NOT NULL,
  bucket TEXT NOT NULL,
  catches INTEGER NOT NULL,
  hours REAL NOT NULL,
  rate REAL NOT NULL,
  baseline_rate REAL NOT NULL,
  multiplier REAL NOT NULL,
  confidence TEXT NOT NULL,                     -- early | promising | solid
  computed_at INTEGER NOT NULL
);
CREATE INDEX idx_pattern_user_scope ON pattern_cache(user_id, scope, multiplier);
