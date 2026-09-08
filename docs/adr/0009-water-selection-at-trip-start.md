# ADR-0009: Water selection at trip start, not 300 m auto-detection

Status: accepted
Date: 2026-09-08

## Context

`docs/waterlog-startup-packet.md` §09 specifies flow 2 as: "Open app ≤300m from a known water
body → banner 'Fishing [Lake Name]? Start trip.' One tap."

Two things block that as written.

**We have no shoreline geometry.** `water_bodies` stores a single centroid
(`centroid_lat`/`centroid_lng`, migration 0001). "Within 300 m of the water body" therefore
evaluates as "within 300 m of the centroid" — the middle of the lake, which is water, not a
place anglers stand. On Norris Lake the centroid is ~16 km from the dam ramp and further from
most of its 800 km of shoreline, so the test would never fire on the founder's home water.
The same structural problem as ADR-0008: reservoirs are what this product targets, and
point-proximity heuristics fail on them specifically.

**Nothing could set a water body anyway.** Until this change there was no way for the client to
list or create one: `startTrip()` hardcoded `water_body_id: null`, and there was no
`/api/water-bodies` route. That is not cosmetic. `workers/enrich` reads the trip's water body to
find its NWPS pool gauge and its centroid fallback, so every trip logged so far could only ever
get weather and astronomy — the reservoir work in ADR-0008 was unreachable in practice.

## Decision

The trip banner picks the water explicitly, ranked by distance:

1. `GET /api/water-bodies` lists the angler's waters (home water first, then alphabetical),
   mirrored into Dexie so the picker works offline like everything else.
2. With a GPS fix, the list is re-ordered nearest-centroid-first. The nearest water within
   **60 km** is preselected and the banner reads "Fishing Norris Lake?" — the packet's prompt,
   at a radius a reservoir can actually satisfy. Outside that, the home water is preselected.
   Never a silent guess at a water hours away.
3. The angler can always override the preselection, choose "No water", or add a new water inline
   (`POST /api/water-bodies`), which stores the current fix as its centroid.
4. `POST /api/sync` rejects a trip whose `water_body_id` the caller does not own, rather than
   relying on the FK, which only proves the row exists.

Gauge handles stay off this path. `usgs_gauge_id` is resolved by the enrich worker; a pool gauge
like Norris's `NRST1` is mapped by hand (ADR-0008). The client never guesses either.

## Consequences

- Starting a trip on the preselected water is still one tap; picking a different one is two.
- Trips carry a water body, so pool elevation, the centroid fallback, and Epic 3's per-water
  journal grouping all have something to key on.
- 60 km is sized to a reservoir's own extent, not to a boat ramp: Norris Dam is 39 km from the
  lake's centroid, and the far NE end is further still, so a tight radius would never fire on the
  founder's home water. It is a heuristic, not a boundary — two waters inside it will sometimes
  preselect the wrong one, which is why the picker is always visible and the running banner names
  the water the trip started on.
- Shoreline polygons would let us honor the packet's 300 m literally. That needs a geometry
  source (NHD, OSM) and a point-in-polygon test per water; revisit if beta anglers mis-pick often
  enough to matter.
