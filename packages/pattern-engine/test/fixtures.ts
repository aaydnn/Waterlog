import type {
  CatchInput,
  ConditionFeatures,
  ConditionSlice,
  EngineInput,
  OfferingInput,
  OfferingSessionInput,
  Season,
  TripInput,
} from '../src/types';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const BASE = Date.UTC(2024, 2, 1, 0, 0, 0);

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function poisson(r: () => number, mu: number): number {
  const L = Math.exp(-mu);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}

export const OFFERINGS: OfferingInput[] = [
  { id: 'spin', family: 'spinnerbait', color: 'chartreuse' },
  { id: 'jig', family: 'jig', color: 'green_pumpkin' },
  { id: 'crank', family: 'crankbait', color: 'red' },
  { id: 'worm', family: 'soft_plastic', color: 'watermelon' },
];

const seasonOf = (ms: number): Season => {
  const m = new Date(ms).getUTCMonth();
  return m < 2 || m === 11 ? 'winter' : m < 5 ? 'spring' : m < 8 ? 'summer' : 'fall';
};

export interface GenCtx {
  offering: OfferingInput;
  features: ConditionFeatures;
  trip: TripInput;
  r: () => number;
}

export interface GenOptions {
  seed: number;
  trips: number;
  baseRate?: number;
  effect?: (ctx: GenCtx) => number;
  startOffsetDays?: number;
  spacingDays?: number;
  waters?: string[];
  tripFeatures?: (r: () => number, tripIndex: number) => Partial<ConditionFeatures>;
  offeringChoice?: (r: () => number, trip: TripInput, half: 0 | 1) => OfferingInput;
  idPrefix?: string;
}

export function generate(o: GenOptions): EngineInput {
  const r = rng(o.seed);
  const trips: TripInput[] = [];
  const conditions: ConditionSlice[] = [];
  const catches: CatchInput[] = [];
  const sessions: OfferingSessionInput[] = [];
  const waters = o.waters ?? ['w1', 'w2'];
  const prefix = o.idPrefix ?? 't';
  for (let i = 0; i < o.trips; i++) {
    const day = BASE + ((o.startOffsetDays ?? 0) + i * (o.spacingDays ?? 5)) * DAY;
    const startHour = 5 + Math.floor(r() * 10);
    const startedAt = day + startHour * HOUR;
    const duration = 3 + Math.floor(r() * 3);
    const trip: TripInput = {
      id: `${prefix}${String(i).padStart(3, '0')}`,
      waterBodyId: waters[i % waters.length]!,
      startedAt,
      endedAt: startedAt + duration * HOUR,
      effortSource: 'timer',
      targetSpecies: null,
    };
    trips.push(trip);
    const tf = o.tripFeatures?.(r, i) ?? {};
    const pressureTrend = (['falling', 'stable', 'rising'] as const)[Math.floor(r() * 3)]!;
    const cloudPct = Math.floor(r() * 100);
    const windKph = Math.floor(r() * 30);
    const waterTempC = 8 + ((i * 7) % 20) + r() * 2;
    const half: [OfferingInput, OfferingInput] = [
      o.offeringChoice?.(r, trip, 0) ?? OFFERINGS[Math.floor(r() * 4)]!,
      o.offeringChoice?.(r, trip, 1) ?? OFFERINGS[Math.floor(r() * 4)]!,
    ];
    const mid = startedAt + (duration / 2) * HOUR;
    sessions.push({ tripId: trip.id, offeringId: half[0].id, start: startedAt, end: null, source: 'tap' });
    sessions.push({ tripId: trip.id, offeringId: half[1].id, start: mid, end: null, source: 'tap' });
    let n = 0;
    for (let h = 0; h < duration; h++) {
      const s = startedAt + h * HOUR;
      const hourOfDay = startHour + h;
      const features: ConditionFeatures = {
        pressureTrend,
        cloudPct,
        windKph,
        waterTempC,
        airTempC: waterTempC + 4,
        waterTempDelta72hC: (i % 3) - 1,
        precipPrev48hMm: (i * 5) % 15,
        moonPhase: ((i * 0.13) % 1),
        minutesFromSunrise: Math.round((hourOfDay - 6.5) * 60),
        minutesToSunset: Math.round((19.5 - hourOfDay) * 60),
        season: seasonOf(s),
        ...tf,
      };
      conditions.push({ tripId: trip.id, start: s, end: s + HOUR, features });
      for (let q = 0; q < 4; q++) {
        const t0 = s + q * 15 * 60_000;
        const offering = t0 < mid ? half[0] : half[1];
        const mu = (o.baseRate ?? 0.6) * 0.25 * (o.effect?.({ offering, features, trip, r }) ?? 1);
        const k = poisson(r, mu);
        for (let j = 0; j < k; j++) {
          catches.push({
            id: `${trip.id}-c${n++}`,
            tripId: trip.id,
            caughtAt: t0 + Math.floor(r() * 15 * 60_000),
            offeringId: offering.id,
            species: r() < 0.8 ? 'largemouth_bass' : 'bluegill',
            lengthMm: 200 + Math.floor(r() * 300),
          });
        }
      }
    }
  }
  const last = trips[trips.length - 1]!;
  return {
    userId: 'u1',
    now: last.endedAt + DAY,
    trips,
    conditions,
    catches,
    offerings: OFFERINGS,
    offeringSessions: sessions,
  };
}

export function merge(a: EngineInput, b: EngineInput): EngineInput {
  return {
    ...a,
    now: Math.max(a.now, b.now),
    trips: [...a.trips, ...b.trips],
    conditions: [...a.conditions, ...b.conditions],
    catches: [...a.catches, ...b.catches],
    offeringSessions: [...a.offeringSessions, ...b.offeringSessions],
  };
}

export function shuffled<T>(arr: ReadonlyArray<T>, seed: number): T[] {
  const r = rng(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
