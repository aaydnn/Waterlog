-- Reservoir coverage + water temperature (ADR-0008).
--
-- USGS instruments rivers, not reservoirs: field validation found no USGS gauge within 15 km of
-- six of eight points across Norris Lake, and no water-temperature station within 60 km of either
-- founder water. NOAA's NWPS API publishes hourly pool elevation for 849 reservoirs instead.

-- Pool gauges are mapped explicitly, never by proximity. Pool elevation is uniform across a
-- reservoir, so the correct gauge is the one at that lake's dam — which may be far from the
-- centroid, while a *different* reservoir's dam sits closer. From the Norris centroid, Cherokee
-- Dam is 26.6 km away and Norris Dam ~40 km, so nearest-wins would silently pick the wrong lake.
ALTER TABLE water_bodies ADD COLUMN nwps_gauge_id TEXT;

-- Angler-measured surface temperature (most boats read it off the transducer). Optional, and
-- always preferred over the model when present: it is the actual water, at the actual time.
--
-- Held per trip rather than per catch, for two reasons. Anglers take one reading per outing, not
-- one per fish; and F1's ten-second capture is an acceptance criterion (packet §10), so the
-- capture flow cannot grow a numeric input. The trip banner has no such time pressure.
ALTER TABLE trips ADD COLUMN water_temp_c REAL;

-- Reservoir level, and its tailwater stage as a generation indicator.
ALTER TABLE conditions ADD COLUMN pool_elevation_ft REAL;
ALTER TABLE conditions ADD COLUMN tailwater_ft REAL;

-- Which source water_temp_c came from, so Epic 4 can weight a measurement above an estimate:
-- 'measured' (angler) | 'gauge' (USGS 00010) | 'modeled' (damped air-temp model) | NULL (absent).
ALTER TABLE conditions ADD COLUMN water_temp_source TEXT;
