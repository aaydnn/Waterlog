-- Adds a client-assigned idempotency key to trips, mirroring catches.client_id.
-- See docs/adr/0003-trip-client-id.md for why.
ALTER TABLE trips ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX idx_trips_client_id ON trips(client_id);
