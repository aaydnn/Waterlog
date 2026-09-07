# ADR-0006: `suncalc` for moon phase and sunrise instead of a hand-rolled formula

Status: accepted
Date: 2026-09-07

## Context

`docs/waterlog-startup-packet.md` §07 specifies moon phase as "computed locally... pure function
of date (synodic month = 29.53059 d from a known new-moon epoch)" and sun times as similarly
computed locally, without naming a library — the wording reads as a hand-rolled implementation.

Epic 2 (Enrichment) needs both: `conditions.moon_phase` and `conditions.minutes_from_sunrise`.
Sunrise in particular requires real solar-position math (declination, equation of time, hour
angle by latitude/longitude/date) — reimplementing that from scratch is easy to get subtly wrong
in ways that don't show up until tested against real dates at real latitudes.

## Decision

Use the `suncalc` npm package (MIT-licensed, ~200 lines, zero dependencies, zero network calls)
for both `moonPhaseAt` and `minutesFromSunrise` (`workers/enrich/src/lib/astro.ts`), rather than
hand-rolling the packet's literal formula.

This is a deviation from the packet's specific wording, not from its underlying principle: the
principle (§07) is "never pay latency and dependency cost for deterministic, computable values" —
i.e., no external API for arithmetic. `suncalc` is pure arithmetic bundled as a library: it makes
no network calls (confirmed by reading its source — `toJulian()` derives everything from
`date.valueOf()`, the absolute epoch millisecond, not from a network round-trip or even from the
runtime's local timezone). It satisfies "computed locally" exactly as written; only the choice of
who wrote the arithmetic differs from the packet's phrasing.

Validated in `workers/enrich/test/astro.test.ts` against 27 published reference points from the
US Naval Observatory API (`aa.usno.navy.mil/api`) — 20 named moon-phase events (new/full/first
quarter/last quarter, Jan–May 2026) and 7 sunrise times across the year for a fixed reference
location (Nashville, TN) — within a small tolerance (~21h phase-fraction, ~3min sunrise).

## Consequences

- One new runtime dependency (`suncalc` + `@types/suncalc`) in `workers/enrich`. No network
  surface, no API key, no failure mode beyond what already exists (a bug in a well-established,
  widely-used library vs. a bug in code written for this repo).
- If the founder later wants the literal packet formula for pedagogical/audit reasons, or hits an
  astronomical edge case `suncalc` gets wrong (it uses low-precision approximations, adequate for
  dawn/dusk bucketing, not surveying-grade), swapping the implementation inside `astro.ts` doesn't
  change any caller — `moonPhaseAt`/`minutesFromSunrise` are the stable interface.
