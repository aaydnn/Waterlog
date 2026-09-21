-- Trip effort capture: how a trip's clock was established, what the angler was after, and a slot
-- for the post-trip lesson.
--
-- These three columns arrive with the capture work described in ADR-0017, ahead of the v2 engine
-- that consumes them. They are here rather than in the v2 migration because the shipped API and
-- client already read and write them: `createTrip` lists them in its column set, the trip timer
-- sets `effort_source = 'timer'`, and the orphan-trip path sets `reconstructed`. A column the
-- deployed code writes belongs in the migration that ships with that code.

-- How a trip's clock was established, which is how much the exposure denominator can be trusted:
-- `timer` was running while it happened, `manual` was typed in afterwards, `reconstructed` was
-- inferred (F10 camera-roll imports and orphan auto-created trips). Feeds evidence quality.
--
-- NOT NULL with a default so every trip already in the table becomes `manual`, which is the
-- honest reading of a row whose clock nobody recorded.
ALTER TABLE trips ADD COLUMN effort_source TEXT NOT NULL DEFAULT 'manual';

-- Species slug, 'mixed', or NULL for "didn't say". A bass trip that caught no bass is not the
-- same observation as a panfish trip that caught six, and without the target the engine cannot
-- tell them apart.
ALTER TABLE trips ADD COLUMN target_species TEXT;

-- Post-trip lesson, written by the cron consumer after the run that follows a trip's enrichment.
-- Display-only, on the trip detail screen. Stays NULL until the v2 engine lands.
ALTER TABLE trips ADD COLUMN lesson_json TEXT;
