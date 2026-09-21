-- WaterLog PATTERN seed. NOT a migration, and NOT for production.
--   cd workers/api && pnpm exec wrangler d1 execute DB --local --file=../../migrations/seed/patterns-seed.sql
--
-- Why this exists: the main dev seed has no `conditions` rows at all — its catches are still
-- `enrich_status = 'pending'` — and the pattern engine divides by exposure hours. Without hours
-- there is nothing to compute, and getting them the real way means running the enrich worker
-- against live Open-Meteo. This file writes the hours directly, so the engine can be exercised
-- offline and the numbers on the cards can be checked by hand.
--
-- The angler is deliberately `tier = 'pro'` so the feed comes back unredacted. Sign in as
-- patterns@waterlog.app to see it; the free-tier view is demo@waterlog.app from the main seed.
--
-- Shape: 6 trips x 4 hours = 24 exposure hours. Every trip opens with one hour of FALLING
-- pressure at DAWN that produces 3 chartreuse fish, then 3 STABLE hours through the MORNING
-- that produce 1 white fish. 24 catches over 24 hours, so the baseline is exactly 1.0/hr and
-- every multiplier below is checkable in your head.
--
-- Expect, per scope (all waters, and Pattern Lake):
--   falling pressure / dawn / partly cloudy / light wind  3.00x  18 catches  6 hrs   6 trips
--   stable pressure / morning / clear / calm              0.33x   6 catches 18 hrs   6 trips
--   chartreuse, spinnerbait                               1.50x  18 catches 12 hrs   6 trips  SOLID
--   white, soft plastic                                   0.50x   6 catches 12 hrs   6 trips
--
-- The lure hours are 12, not 24, because two offerings caught on every trip and each takes half
-- of its hours (ADR-0015). No COMBO card appears, and that is the anti-confounding rule working:
-- pressure, sky, time and wind move together in this data, so "dawn + falling" is 3.0x against
-- parents that are already 3.0x and has to clear 3.75x to be a separate insight. It does not.

DELETE FROM pattern_cache WHERE user_id = 'usr_patt01';
DELETE FROM pattern_runs WHERE user_id = 'usr_patt01';
DELETE FROM conditions WHERE user_id = 'usr_patt01';
DELETE FROM catches WHERE user_id = 'usr_patt01';
DELETE FROM trips WHERE user_id = 'usr_patt01';
DELETE FROM lures WHERE user_id = 'usr_patt01';
DELETE FROM water_bodies WHERE user_id = 'usr_patt01';
DELETE FROM users WHERE id = 'usr_patt01';

INSERT INTO users (id, email, display_name, home_lat, home_lng, units, tier, created_at, updated_at) VALUES
  ('usr_patt01', 'patterns@waterlog.app', 'Pattern Angler', 36.2270, -84.0930, 'imperial', 'pro', 1780740000000, 1780740000000);

INSERT INTO water_bodies (id, user_id, name, kind, centroid_lat, centroid_lng, is_home, created_at, updated_at) VALUES
  ('wb_patt01', 'usr_patt01', 'Pattern Lake', 'reservoir', 36.2270, -84.0930, 1, 1780740000000, 1780740000000);

INSERT INTO lures (id, user_id, name, family, color, cost_cents, created_at, updated_at) VALUES
  ('lur_patt01', 'usr_patt01', 'Chartreuse Spinnerbait 3/8 oz', 'spinnerbait', 'chartreuse', 899, 1780740000000, 1780740000000),
  ('lur_patt02', 'usr_patt01', 'White Swimbait 4in', 'soft_plastic', 'white', 649, 1780740000000, 1780740000000);

INSERT INTO trips (id, user_id, water_body_id, started_at, ended_at, auto_created, planned, notes, water_temp_c, created_at, updated_at, client_id) VALUES
  ('trp_patt01', 'usr_patt01', 'wb_patt01', 1780740000000, 1780754400000, 0, 0, 'Seeded trip 1.', 21.5, 1780740000000, 1780754400000, 'seed_trp_patt01'),
  ('trp_patt02', 'usr_patt01', 'wb_patt01', 1781344800000, 1781359200000, 0, 0, 'Seeded trip 2.', 21.5, 1781344800000, 1781359200000, 'seed_trp_patt02'),
  ('trp_patt03', 'usr_patt01', 'wb_patt01', 1781949600000, 1781964000000, 0, 0, 'Seeded trip 3.', 21.5, 1781949600000, 1781964000000, 'seed_trp_patt03'),
  ('trp_patt04', 'usr_patt01', 'wb_patt01', 1782554400000, 1782568800000, 0, 0, 'Seeded trip 4.', 21.5, 1782554400000, 1782568800000, 'seed_trp_patt04'),
  ('trp_patt05', 'usr_patt01', 'wb_patt01', 1783159200000, 1783173600000, 0, 0, 'Seeded trip 5.', 21.5, 1783159200000, 1783173600000, 'seed_trp_patt05'),
  ('trp_patt06', 'usr_patt01', 'wb_patt01', 1783764000000, 1783778400000, 0, 0, 'Seeded trip 6.', 21.5, 1783764000000, 1783778400000, 'seed_trp_patt06');

INSERT INTO catches (id, user_id, trip_id, lure_id, species, caught_at, lat, lng, photo_key, length_mm, weight_g, depth_m, released, notes, client_id, enrich_status, created_at, updated_at) VALUES
  ('cat_patt01', 'usr_patt01', 'trp_patt01', 'lur_patt01', 'largemouth_bass', 1780740420000, 36.2270, -84.0930, NULL, 430, 1350, 1.5, 1, NULL, 'seed_cat_patt01', 'done', 1780740420000, 1780740420000),
  ('cat_patt02', 'usr_patt01', 'trp_patt01', 'lur_patt01', 'largemouth_bass', 1780740840000, 36.2270, -84.0930, NULL, 380, 900, 1.5, 1, NULL, 'seed_cat_patt02', 'done', 1780740840000, 1780740840000),
  ('cat_patt03', 'usr_patt01', 'trp_patt01', 'lur_patt01', 'smallmouth_bass', 1780741260000, 36.2270, -84.0930, NULL, 355, 780, 1.5, 1, NULL, 'seed_cat_patt03', 'done', 1780741260000, 1780741260000),
  ('cat_patt04', 'usr_patt01', 'trp_patt01', 'lur_patt02', 'white_bass', 1780745280000, 36.2270, -84.0930, NULL, 290, 360, 1.5, 1, NULL, 'seed_cat_patt04', 'done', 1780745280000, 1780745280000),
  ('cat_patt05', 'usr_patt01', 'trp_patt02', 'lur_patt01', 'largemouth_bass', 1781345220000, 36.2270, -84.0930, NULL, 430, 1350, 1.5, 1, NULL, 'seed_cat_patt05', 'done', 1781345220000, 1781345220000),
  ('cat_patt06', 'usr_patt01', 'trp_patt02', 'lur_patt01', 'largemouth_bass', 1781345640000, 36.2270, -84.0930, NULL, 380, 900, 1.5, 1, NULL, 'seed_cat_patt06', 'done', 1781345640000, 1781345640000),
  ('cat_patt07', 'usr_patt01', 'trp_patt02', 'lur_patt01', 'smallmouth_bass', 1781346060000, 36.2270, -84.0930, NULL, 355, 780, 1.5, 1, NULL, 'seed_cat_patt07', 'done', 1781346060000, 1781346060000),
  ('cat_patt08', 'usr_patt01', 'trp_patt02', 'lur_patt02', 'white_bass', 1781350080000, 36.2270, -84.0930, NULL, 290, 360, 1.5, 1, NULL, 'seed_cat_patt08', 'done', 1781350080000, 1781350080000),
  ('cat_patt09', 'usr_patt01', 'trp_patt03', 'lur_patt01', 'largemouth_bass', 1781950020000, 36.2270, -84.0930, NULL, 430, 1350, 1.5, 1, NULL, 'seed_cat_patt09', 'done', 1781950020000, 1781950020000),
  ('cat_patt10', 'usr_patt01', 'trp_patt03', 'lur_patt01', 'largemouth_bass', 1781950440000, 36.2270, -84.0930, NULL, 380, 900, 1.5, 1, NULL, 'seed_cat_patt10', 'done', 1781950440000, 1781950440000),
  ('cat_patt11', 'usr_patt01', 'trp_patt03', 'lur_patt01', 'smallmouth_bass', 1781950860000, 36.2270, -84.0930, NULL, 355, 780, 1.5, 1, NULL, 'seed_cat_patt11', 'done', 1781950860000, 1781950860000),
  ('cat_patt12', 'usr_patt01', 'trp_patt03', 'lur_patt02', 'white_bass', 1781954880000, 36.2270, -84.0930, NULL, 290, 360, 1.5, 1, NULL, 'seed_cat_patt12', 'done', 1781954880000, 1781954880000),
  ('cat_patt13', 'usr_patt01', 'trp_patt04', 'lur_patt01', 'largemouth_bass', 1782554820000, 36.2270, -84.0930, NULL, 430, 1350, 1.5, 1, NULL, 'seed_cat_patt13', 'done', 1782554820000, 1782554820000),
  ('cat_patt14', 'usr_patt01', 'trp_patt04', 'lur_patt01', 'largemouth_bass', 1782555240000, 36.2270, -84.0930, NULL, 380, 900, 1.5, 1, NULL, 'seed_cat_patt14', 'done', 1782555240000, 1782555240000),
  ('cat_patt15', 'usr_patt01', 'trp_patt04', 'lur_patt01', 'smallmouth_bass', 1782555660000, 36.2270, -84.0930, NULL, 355, 780, 1.5, 1, NULL, 'seed_cat_patt15', 'done', 1782555660000, 1782555660000),
  ('cat_patt16', 'usr_patt01', 'trp_patt04', 'lur_patt02', 'white_bass', 1782559680000, 36.2270, -84.0930, NULL, 290, 360, 1.5, 1, NULL, 'seed_cat_patt16', 'done', 1782559680000, 1782559680000),
  ('cat_patt17', 'usr_patt01', 'trp_patt05', 'lur_patt01', 'largemouth_bass', 1783159620000, 36.2270, -84.0930, NULL, 430, 1350, 1.5, 1, NULL, 'seed_cat_patt17', 'done', 1783159620000, 1783159620000),
  ('cat_patt18', 'usr_patt01', 'trp_patt05', 'lur_patt01', 'largemouth_bass', 1783160040000, 36.2270, -84.0930, NULL, 380, 900, 1.5, 1, NULL, 'seed_cat_patt18', 'done', 1783160040000, 1783160040000),
  ('cat_patt19', 'usr_patt01', 'trp_patt05', 'lur_patt01', 'smallmouth_bass', 1783160460000, 36.2270, -84.0930, NULL, 355, 780, 1.5, 1, NULL, 'seed_cat_patt19', 'done', 1783160460000, 1783160460000),
  ('cat_patt20', 'usr_patt01', 'trp_patt05', 'lur_patt02', 'white_bass', 1783164480000, 36.2270, -84.0930, NULL, 290, 360, 1.5, 1, NULL, 'seed_cat_patt20', 'done', 1783164480000, 1783164480000),
  ('cat_patt21', 'usr_patt01', 'trp_patt06', 'lur_patt01', 'largemouth_bass', 1783764420000, 36.2270, -84.0930, NULL, 430, 1350, 1.5, 1, NULL, 'seed_cat_patt21', 'done', 1783764420000, 1783764420000),
  ('cat_patt22', 'usr_patt01', 'trp_patt06', 'lur_patt01', 'largemouth_bass', 1783764840000, 36.2270, -84.0930, NULL, 380, 900, 1.5, 1, NULL, 'seed_cat_patt22', 'done', 1783764840000, 1783764840000),
  ('cat_patt23', 'usr_patt01', 'trp_patt06', 'lur_patt01', 'smallmouth_bass', 1783765260000, 36.2270, -84.0930, NULL, 355, 780, 1.5, 1, NULL, 'seed_cat_patt23', 'done', 1783765260000, 1783765260000),
  ('cat_patt24', 'usr_patt01', 'trp_patt06', 'lur_patt02', 'white_bass', 1783769280000, 36.2270, -84.0930, NULL, 290, 360, 1.5, 1, NULL, 'seed_cat_patt24', 'done', 1783769280000, 1783769280000);

-- One row per trip-hour: the exposure denominator. Written here rather than enriched, so this
-- works with no network and no queue.
INSERT INTO conditions (id, user_id, catch_id, trip_id, hour_bucket, air_temp_c, cloud_pct, wind_kph, precip_mm, pressure_hpa, pressure_trend, moon_phase, minutes_from_sunrise, water_temp_c, water_temp_source, season, source_meta, created_at) VALUES
  ('cnd_trp_patt01_0', 'usr_patt01', NULL, 'trp_patt01', 494650, 18.5, 40, 14, 0.0, 1006.2, 'falling', 0.46, 0, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1780740000000),
  ('cnd_trp_patt01_1', 'usr_patt01', NULL, 'trp_patt01', 494651, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 150, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1780740000000),
  ('cnd_trp_patt01_2', 'usr_patt01', NULL, 'trp_patt01', 494652, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 210, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1780740000000),
  ('cnd_trp_patt01_3', 'usr_patt01', NULL, 'trp_patt01', 494653, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 270, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1780740000000),
  ('cnd_trp_patt02_0', 'usr_patt01', NULL, 'trp_patt02', 494818, 18.5, 40, 14, 0.0, 1006.2, 'falling', 0.46, 0, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1781344800000),
  ('cnd_trp_patt02_1', 'usr_patt01', NULL, 'trp_patt02', 494819, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 150, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1781344800000),
  ('cnd_trp_patt02_2', 'usr_patt01', NULL, 'trp_patt02', 494820, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 210, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1781344800000),
  ('cnd_trp_patt02_3', 'usr_patt01', NULL, 'trp_patt02', 494821, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 270, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1781344800000),
  ('cnd_trp_patt03_0', 'usr_patt01', NULL, 'trp_patt03', 494986, 18.5, 40, 14, 0.0, 1006.2, 'falling', 0.46, 0, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1781949600000),
  ('cnd_trp_patt03_1', 'usr_patt01', NULL, 'trp_patt03', 494987, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 150, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1781949600000),
  ('cnd_trp_patt03_2', 'usr_patt01', NULL, 'trp_patt03', 494988, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 210, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1781949600000),
  ('cnd_trp_patt03_3', 'usr_patt01', NULL, 'trp_patt03', 494989, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 270, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1781949600000),
  ('cnd_trp_patt04_0', 'usr_patt01', NULL, 'trp_patt04', 495154, 18.5, 40, 14, 0.0, 1006.2, 'falling', 0.46, 0, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1782554400000),
  ('cnd_trp_patt04_1', 'usr_patt01', NULL, 'trp_patt04', 495155, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 150, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1782554400000),
  ('cnd_trp_patt04_2', 'usr_patt01', NULL, 'trp_patt04', 495156, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 210, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1782554400000),
  ('cnd_trp_patt04_3', 'usr_patt01', NULL, 'trp_patt04', 495157, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 270, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1782554400000),
  ('cnd_trp_patt05_0', 'usr_patt01', NULL, 'trp_patt05', 495322, 18.5, 40, 14, 0.0, 1006.2, 'falling', 0.46, 0, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1783159200000),
  ('cnd_trp_patt05_1', 'usr_patt01', NULL, 'trp_patt05', 495323, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 150, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1783159200000),
  ('cnd_trp_patt05_2', 'usr_patt01', NULL, 'trp_patt05', 495324, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 210, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1783159200000),
  ('cnd_trp_patt05_3', 'usr_patt01', NULL, 'trp_patt05', 495325, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 270, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1783159200000),
  ('cnd_trp_patt06_0', 'usr_patt01', NULL, 'trp_patt06', 495490, 18.5, 40, 14, 0.0, 1006.2, 'falling', 0.46, 0, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1783764000000),
  ('cnd_trp_patt06_1', 'usr_patt01', NULL, 'trp_patt06', 495491, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 150, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1783764000000),
  ('cnd_trp_patt06_2', 'usr_patt01', NULL, 'trp_patt06', 495492, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 210, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1783764000000),
  ('cnd_trp_patt06_3', 'usr_patt01', NULL, 'trp_patt06', 495493, 24, 15, 6, 0.0, 1014.8, 'stable', 0.46, 270, 21.5, 'measured', 'summer', '{"source":"patterns-seed"}', 1783764000000);

