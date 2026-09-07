-- Cloudflare Queues delivers at-least-once, so a retried/redelivered enrich job must not create
-- a duplicate conditions row (same idempotency principle as trips/catches client_id dedupe).
-- Partial unique indexes let a catch row (trip_id/hour_bucket NULL) and a trip-hour row
-- (catch_id NULL) coexist under one table without colliding with each other.
CREATE UNIQUE INDEX idx_conditions_catch_unique ON conditions(catch_id) WHERE catch_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conditions_trip_hour_unique ON conditions(trip_id, hour_bucket)
  WHERE trip_id IS NOT NULL AND hour_bucket IS NOT NULL;
