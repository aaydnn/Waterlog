-- WaterLog dev seed. NOT a migration — apply with:
--   wrangler d1 execute DB --local --file=../../migrations/seed/seed.sql
-- Never run against production.
--
-- Shape matters: Epic 3 stats and Epic 4 pattern math sanity-check against
-- this data. It deliberately contains one zero-catch (skunk) trip — the
-- denominator concept — plus lure variety across families and colors.
-- Timestamps are unix epoch milliseconds; trips are in June/July 2026.

-- 1 demo user
INSERT INTO users (id, email, display_name, home_lat, home_lng, units, tier, stripe_customer_id, created_at, updated_at, deleted_at) VALUES
  ('usr_demo01', 'demo@waterlog.app', 'Demo Angler', 36.0331, -86.7828, 'imperial', 'free', NULL, 1780315200000, 1780315200000, NULL);

-- 2 water bodies (TN-plausible)
INSERT INTO water_bodies (id, user_id, name, kind, centroid_lat, centroid_lng, usgs_gauge_id, is_home, created_at, updated_at, deleted_at) VALUES
  ('wb_percy01', 'usr_demo01', 'Percy Priest Lake', 'lake', 36.0605, -86.5515, NULL, 1, 1780315200000, 1780315200000, NULL),
  ('wb_caney01', 'usr_demo01', 'Caney Fork River', 'river', 36.1020, -85.7905, '03421000', 0, 1780315200000, 1780315200000, NULL);

-- 4 lures: 4 families, 4 colors, two with cost_cents
INSERT INTO lures (id, user_id, name, family, color, cost_cents, retired_at, created_at, updated_at, deleted_at) VALUES
  ('lur_spin01', 'usr_demo01', 'War Eagle Spinnerbait 3/8 oz', 'spinnerbait', 'chartreuse', 899, NULL, 1780315200000, 1780315200000, NULL),
  ('lur_senk01', 'usr_demo01', '5in Senko', 'soft_plastic', 'green_pumpkin', 799, NULL, 1780315200000, 1780315200000, NULL),
  ('lur_jigf01', 'usr_demo01', 'Football Jig 1/2 oz', 'jig', 'brown', NULL, NULL, 1780315200000, 1780315200000, NULL),
  ('lur_popr01', 'usr_demo01', 'Pop-R Popper', 'topwater', 'bone', NULL, NULL, 1780315200000, 1780315200000, NULL);

-- 3 trips: 3.5h on the lake, 5h on the river, and a 2h SKUNK (zero catches).
INSERT INTO trips (id, user_id, water_body_id, started_at, ended_at, auto_created, planned, notes, created_at, updated_at, deleted_at) VALUES
  ('trp_00001', 'usr_demo01', 'wb_percy01', 1780743600000, 1780756200000, 0, 1, 'Dawn bite on main-lake points.', 1780743600000, 1780756200000, NULL),
  ('trp_00002', 'usr_demo01', 'wb_caney01', 1781951400000, 1781969400000, 1, 0, 'Generation off until noon; drifted the upper mile.', 1781951400000, 1781969400000, NULL),
  ('trp_00003', 'usr_demo01', 'wb_percy01', 1783162800000, 1783170000000, 0, 1, 'July 4th, bluebird sky, boat traffic everywhere. Skunked.', 1783162800000, 1783170000000, NULL);

-- 12 catches: 7 on trip 1, 5 on trip 2, none on trip 3.
INSERT INTO catches (id, user_id, trip_id, lure_id, species, caught_at, lat, lng, photo_key, length_mm, weight_g, depth_m, released, notes, client_id, enrich_status, created_at, updated_at, deleted_at) VALUES
  ('cat_00001', 'usr_demo01', 'trp_00001', 'lur_popr01', 'largemouth_bass', 1780744500000, 36.0581, -86.5490, NULL, 385, 950, 0.5, 1, 'Blew up on the popper at first light.', '01JX00000000000000000001', 'pending', 1780744500000, 1780744500000, NULL),
  ('cat_00002', 'usr_demo01', 'trp_00001', 'lur_popr01', 'largemouth_bass', 1780746000000, 36.0577, -86.5478, NULL, 310, 480, 0.5, 1, NULL, '01JX00000000000000000002', 'pending', 1780746000000, 1780746000000, NULL),
  ('cat_00003', 'usr_demo01', 'trp_00001', 'lur_spin01', 'largemouth_bass', 1780746900000, 36.0602, -86.5531, NULL, 442, 1450, 1.8, 1, 'Windblown point, slow roll.', '01JX00000000000000000003', 'pending', 1780746900000, 1780746900000, NULL),
  ('cat_00004', 'usr_demo01', 'trp_00001', 'lur_spin01', 'white_bass', 1780748400000, 36.0611, -86.5548, NULL, 280, 340, 2.0, 1, NULL, '01JX00000000000000000004', 'pending', 1780748400000, 1780748400000, NULL),
  ('cat_00005', 'usr_demo01', 'trp_00001', 'lur_senk01', 'largemouth_bass', 1780750200000, 36.0630, -86.5560, NULL, 355, 720, 2.5, 0, 'Kept for dinner.', '01JX00000000000000000005', 'pending', 1780750200000, 1780750200000, NULL),
  ('cat_00006', 'usr_demo01', 'trp_00001', 'lur_jigf01', 'bluegill', 1780752600000, 36.0644, -86.5572, NULL, 190, 150, 3.0, 1, NULL, '01JX00000000000000000006', 'pending', 1780752600000, 1780752600000, NULL),
  ('cat_00007', 'usr_demo01', 'trp_00001', 'lur_jigf01', 'channel_catfish', 1780755300000, 36.0652, -86.5581, NULL, 510, 1900, 4.5, 1, 'Surprise on the jig, dragged bottom.', '01JX00000000000000000007', 'pending', 1780755300000, 1780755300000, NULL),
  ('cat_00008', 'usr_demo01', 'trp_00002', 'lur_jigf01', 'rainbow_trout', 1781952900000, 36.1032, -85.7921, NULL, 330, 400, 1.2, 1, NULL, '01JX00000000000000000008', 'pending', 1781952900000, 1781952900000, NULL),
  ('cat_00009', 'usr_demo01', 'trp_00002', 'lur_senk01', 'rainbow_trout', 1781955600000, 36.1041, -85.7935, NULL, 355, 470, 1.0, 1, 'Wacky rig in the slow pool.', '01JX00000000000000000009', 'pending', 1781955600000, 1781955600000, NULL),
  ('cat_00010', 'usr_demo01', 'trp_00002', 'lur_spin01', 'brown_trout', 1781959200000, 36.1056, -85.7952, NULL, 480, 1300, 1.5, 1, 'Best brown of the year so far.', '01JX00000000000000000010', 'pending', 1781959200000, 1781959200000, NULL),
  ('cat_00011', 'usr_demo01', 'trp_00002', 'lur_jigf01', 'brown_trout', 1781962800000, 36.1068, -85.7970, NULL, 290, 280, 1.8, 1, NULL, '01JX00000000000000000011', 'pending', 1781962800000, 1781962800000, NULL),
  ('cat_00012', 'usr_demo01', 'trp_00002', 'lur_senk01', 'rainbow_trout', 1781967000000, 36.1080, -85.7988, NULL, 405, 640, 0.8, 1, 'Right before generation kicked on.', '01JX00000000000000000012', 'pending', 1781967000000, 1781967000000, NULL);
