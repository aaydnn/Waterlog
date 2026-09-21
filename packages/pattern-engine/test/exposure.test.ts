import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { comboDimension, flowTrend, moon, rainPrev48h, resolveDimension, sky, timeBlock, waterTemp, waterTempTrend, wind } from '../src/dimensions';
import { bucketPhrase, findingSummary, outcomePrefix } from '../src/explain';
import { buildExposure } from '../src/exposure';
import type { EngineInput } from '../src/types';
import { HOUR, OFFERINGS } from './fixtures';

const T0 = Date.UTC(2025, 5, 1, 6);
const base = (over: Partial<EngineInput> = {}): EngineInput => ({
  userId: 'u',
  now: T0 + 10 * HOUR,
  trips: [{ id: 'a', waterBodyId: 'w', startedAt: T0, endedAt: T0 + 4 * HOUR, effortSource: 'timer' }],
  conditions: [0, 1, 2].map((h) => ({ tripId: 'a', start: T0 + h * HOUR, end: T0 + (h + 1) * HOUR, features: { season: 'summer', cloudPct: 10 } })),
  catches: [],
  offerings: OFFERINGS,
  offeringSessions: [],
  ...over,
});

describe('fishable exposure', () => {
  it('subtracts pauses and keeps uncovered time with unknown conditions', () => {
    const ex = buildExposure(
      base({ trips: [{ id: 'a', waterBodyId: 'w', startedAt: T0, endedAt: T0 + 4 * HOUR, effortSource: 'manual', pauses: [{ start: T0 + HOUR, end: T0 + 1.5 * HOUR }, { start: T0 + 9 * HOUR, end: T0 + 10 * HOUR }] }] }),
      DEFAULT_CONFIG,
    );
    expect(ex.trips[0]!.fishableHours).toBeCloseTo(3.5);
    expect(ex.clock.reduce((s, c) => s + c.hours, 0)).toBeCloseTo(3.5);
    expect(ex.clock.at(-1)!.features).toEqual({});
    expect(ex.clock.every((c) => c.quality === 'estimated')).toBe(true);
    expect(ex.dataQuality.measuredShare).toBe(0);
    expect(ex.dataQuality.tripsWithoutOfferingLogs).toBe(1);
  });

  it('splits rod time by tie-on sessions, honoring explicit ends and estimated sources', () => {
    const ex = buildExposure(
      base({
        trips: [{ id: 'a', waterBodyId: 'w', startedAt: T0, endedAt: T0 + 4 * HOUR, effortSource: 'reconstructed' }],
        offeringSessions: [
          { tripId: 'a', offeringId: 'spin', start: T0, end: null, source: 'tap' },
          { tripId: 'a', offeringId: 'jig', start: T0 + 2 * HOUR, end: T0 + 3 * HOUR, source: 'estimated' },
          { tripId: 'a', offeringId: 'mystery', start: T0 + 3 * HOUR, end: null, source: 'tap' },
        ],
        catches: [
          { id: 'k1', tripId: 'a', caughtAt: T0 + 30 * 60_000, offeringId: 'spin', species: 'bass', lengthMm: null },
          { id: 'k2', tripId: 'a', caughtAt: T0 + 150 * 60_000, offeringId: 'crank', species: 'bass', lengthMm: null },
          { id: 'k3', tripId: 'a', caughtAt: T0 + 200 * 60_000, offeringId: null, species: 'bass', lengthMm: null },
          { id: 'k4', tripId: 'a', caughtAt: T0 + 5 * HOUR, offeringId: 'mystery', species: 'bass', lengthMm: null },
        ],
      }),
      DEFAULT_CONFIG,
    );
    const hours = (id: string) => ex.rod.filter((c) => c.offering?.id === id).reduce((s, c) => s + c.hours, 0);
    expect(hours('spin')).toBeCloseTo(2);
    expect(hours('jig')).toBeCloseTo(1);
    expect(hours('mystery')).toBeCloseTo(1);
    expect(ex.rod.find((c) => c.offering?.id === 'mystery')!.offering).toEqual({ id: 'mystery', family: null, color: null });
    expect(ex.rod.every((c) => c.quality === 'reconstructed')).toBe(true);
    expect(ex.dataQuality.unmatchedOfferingCatches).toBe(2);
    expect(ex.dataQuality.catchesOutsideEffort).toBe(1);
    expect(ex.questions.map((q) => q.kind).sort()).toEqual(['catch_offering_unmatched', 'catch_offering_unmatched', 'catch_outside_effort']);
    expect(ex.clock.reduce((s, c) => s + c.catches.length, 0)).toBe(4);
    expect(ex.dataQuality.offeringHoursMeasured + ex.dataQuality.offeringHoursEstimated).toBeCloseTo(4);
  });

  it('falls back to apportioned exposure without tie-on logs (ADR-0015), and can disable it', () => {
    const input = base({
      catches: [
        { id: 'k1', tripId: 'a', caughtAt: T0 + 10 * 60_000, offeringId: 'spin', species: 'bass', lengthMm: null },
        { id: 'k2', tripId: 'a', caughtAt: T0 + 20 * 60_000, offeringId: 'jig', species: 'bass', lengthMm: null },
      ],
    });
    const ex = buildExposure(input, DEFAULT_CONFIG);
    expect(ex.rod.every((c) => c.quality === 'apportioned')).toBe(true);
    expect(ex.dataQuality.offeringHoursApportioned).toBeCloseTo(4);
    expect(buildExposure(input, { ...DEFAULT_CONFIG, includeApportionedOfferingExposure: false }).rod).toEqual([]);
  });

  it('drops zero-length trips and handles trips with no fishable time', () => {
    const ex = buildExposure(
      base({
        trips: [
          { id: 'z', waterBodyId: null, startedAt: T0, endedAt: T0, effortSource: 'timer' },
          { id: 'p', waterBodyId: null, startedAt: T0, endedAt: T0 + HOUR, effortSource: 'timer', pauses: [{ start: T0, end: T0 + HOUR }] },
        ],
        catches: [{ id: 'k', tripId: 'p', caughtAt: T0, offeringId: null, species: 'bass', lengthMm: null }],
      }),
      DEFAULT_CONFIG,
    );
    expect(ex.trips.map((t) => t.id)).toEqual(['p']);
    expect(ex.clock).toEqual([]);
  });
});

describe('dimensions', () => {
  it('bands conditions', () => {
    expect([sky({ cloudPct: 5 }), sky({ cloudPct: 50 }), sky({ cloudPct: 90 }), sky({})]).toEqual(['clear', 'partly', 'overcast', null]);
    expect([wind({ windKph: 2 }), wind({ windKph: 15 }), wind({ windKph: 30 }), wind({ windKph: null })]).toEqual(['calm', 'light', 'strong', null]);
    expect([waterTemp({ waterTempC: 17.2 }), waterTemp({})]).toEqual(['15-20c', null]);
    expect([waterTempTrend({ waterTempDelta72hC: -3 }), waterTempTrend({ waterTempDelta72hC: 2 }), waterTempTrend({ waterTempDelta72hC: 0 }), waterTempTrend({})]).toEqual(['cooling', 'warming', 'steady', null]);
    expect([rainPrev48h({ precipPrev48hMm: 0 }), rainPrev48h({ precipPrev48hMm: 5 }), rainPrev48h({ precipPrev48hMm: 30 }), rainPrev48h({})]).toEqual(['dry', 'some_rain', 'heavy_rain', null]);
    expect([flowTrend({ dischargeDelta24hPct: -20 }), flowTrend({ dischargeDelta24hPct: 20 }), flowTrend({ dischargeDelta24hPct: 0 }), flowTrend({})]).toEqual(['falling', 'rising', 'stable', null]);
    expect([moon({ moonPhase: 0.95 }), moon({ moonPhase: 0.25 }), moon({ moonPhase: 0.5 }), moon({ moonPhase: 0.7 }), moon({})]).toEqual(['new', 'first_quarter', 'full', 'last_quarter', null]);
  });

  it('uses actual sunset for time blocks, with a fallback', () => {
    const tb = (mfs: number | null, mts?: number) => timeBlock({ minutesFromSunrise: mfs, minutesToSunset: mts ?? null });
    expect(tb(null)).toBeNull();
    expect(tb(30, 800)).toBe('dawn');
    expect(tb(800, 60)).toBe('dusk');
    expect(tb(-200, 1000)).toBe('night');
    expect(tb(900, -200)).toBe('night');
    expect(tb(200, 700)).toBe('morning');
    expect(tb(600, 200)).toBe('evening');
    expect(tb(500, 400)).toBe('midday');
    expect([tb(500), tb(700), tb(800), tb(1000)]).toEqual(['midday', 'evening', 'dusk', 'night']);
  });

  it('builds and resolves combos', () => {
    expect(comboDimension('sky', 'sky')).toBeUndefined();
    expect(comboDimension('sky', 'nope')).toBeUndefined();
    const d = resolveDimension('wind+sky')!;
    expect(d.key).toBe('sky+wind');
    expect(d.population).toBe('clock');
    expect(resolveDimension('offering_family+sky')!.population).toBe('rod');
    expect(resolveDimension('sky')!.key).toBe('sky');
  });
});

describe('explanations', () => {
  it('renders phrases and tokens', () => {
    expect(bucketPhrase('offering', 'x1')).toBe('{{offering:x1}}');
    expect(bucketPhrase('water_body', 'w')).toBe('{{water:w}}');
    expect(bucketPhrase('water_temp', '15-20c')).toBe('water at 15–20°C');
    expect(bucketPhrase('season', 'spring')).toBe('spring');
    expect(bucketPhrase('sky+wind', 'clear|calm')).toBe('clear skies + calm wind');
    expect(bucketPhrase('unknown_dim', 'a_b')).toBe('a b');
    expect(bucketPhrase('sky+wind', 'clear')).toBe('clear skies + ');
    expect(outcomePrefix('quality')).toBe('Bigger fish — ');
    expect(outcomePrefix('species:bass')).toBe('{{species:bass}} — ');
    const s = { dimension: 'sky', bucket: 'clear', catches: 1, hours: 12, expected: 3, exposedTrips: 1, multiplier: 0.5 } as never;
    expect(findingSummary('all', s)).toBe('Clear skies → 0.5x your comparable rate (1 fish over 12 hrs, 1 trip).');
  });
});
