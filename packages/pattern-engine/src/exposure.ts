import type { EngineConfig } from './config';
import type {
  Cell,
  CatchInput,
  ConditionFeatures,
  DataQuality,
  DataQuestion,
  EngineInput,
  OfferingInput,
  Quality,
  TripMeta,
} from './types';

const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Interval { start: number; end: number }

function subtract(base: Interval, cuts: ReadonlyArray<Interval>): Interval[] {
  let parts: Interval[] = [base];
  for (const c of cuts.slice().sort((a, b) => a.start - b.start)) {
    const next: Interval[] = [];
    for (const p of parts) {
      if (c.end <= p.start || c.start >= p.end) {
        next.push(p);
        continue;
      }
      if (c.start > p.start) next.push({ start: p.start, end: c.start });
      if (c.end < p.end) next.push({ start: c.end, end: p.end });
    }
    parts = next;
  }
  return parts.filter((p) => p.end > p.start);
}

const QUALITY_ORDER: Quality[] = ['measured', 'estimated', 'reconstructed', 'apportioned'];
const worse = (a: Quality, b: Quality): Quality =>
  QUALITY_ORDER.indexOf(a) >= QUALITY_ORDER.indexOf(b) ? a : b;

export interface Exposure {
  trips: TripMeta[];
  /** Clock-time cells: one per fishable interval × condition slice. Every catch counted once. */
  clock: Cell[];
  /** Rod-time cells: clock cell × active offering. Used for offering dimensions only. */
  rod: Cell[];
  questions: DataQuestion[];
  dataQuality: DataQuality;
}

export function buildExposure(input: EngineInput, config: EngineConfig): Exposure {
  const offerings = new Map<string, OfferingInput>(input.offerings.map((o) => [o.id, o]));
  const byTrip = <T extends { tripId: string }>(rows: ReadonlyArray<T>) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.tripId);
      if (list) list.push(r);
      else m.set(r.tripId, [r]);
    }
    return m;
  };
  const condByTrip = byTrip(input.conditions);
  const sessByTrip = byTrip(input.offeringSessions);
  const catchByTrip = byTrip(input.catches);

  const trips = input.trips
    .filter((t) => t.endedAt > t.startedAt)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));

  const clock: Cell[] = [];
  const rod: Cell[] = [];
  const questions: DataQuestion[] = [];
  const dq: DataQuality = {
    fishableHours: 0,
    measuredShare: 0,
    offeringHoursMeasured: 0,
    offeringHoursEstimated: 0,
    offeringHoursApportioned: 0,
    tripsWithoutOfferingLogs: 0,
    unmatchedOfferingCatches: 0,
    catchesOutsideEffort: 0,
  };
  const metas: TripMeta[] = [];
  let measuredHours = 0;

  for (const t of trips) {
    const tripQuality: Quality =
      t.effortSource === 'timer' ? 'measured' : t.effortSource === 'manual' ? 'estimated' : 'reconstructed';
    const fishing = subtract({ start: t.startedAt, end: t.endedAt }, t.pauses ?? []);
    const sessions = (sessByTrip.get(t.id) ?? []).slice().sort((a, b) => a.start - b.start || (a.offeringId < b.offeringId ? -1 : 1));
    const meta: TripMeta = {
      id: t.id,
      waterBodyId: t.waterBodyId,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      week: Math.floor((t.startedAt / DAY + 3) / 7),
      targetSpecies: t.targetSpecies ?? null,
      fishableHours: fishing.reduce((s, f) => s + (f.end - f.start) / HOUR, 0),
      hasOfferingSessions: sessions.length > 0,
    };
    metas.push(meta);
    dq.fishableHours += meta.fishableHours;
    if (tripQuality === 'measured') measuredHours += meta.fishableHours;

    // Clock cells: fishing intervals intersected with condition slices; uncovered time gets empty features.
    const slices = (condByTrip.get(t.id) ?? []).slice().sort((a, b) => a.start - b.start);
    const tripClock: Cell[] = [];
    for (const f of fishing) {
      let cursor = f.start;
      for (const s of slices) {
        const a = Math.max(f.start, s.start);
        const b = Math.min(f.end, s.end);
        if (b <= a) continue;
        if (a > cursor) tripClock.push(mkCell(meta, cursor, a, tripQuality, {}));
        tripClock.push(mkCell(meta, a, b, tripQuality, s.features));
        cursor = Math.max(cursor, b);
      }
      if (cursor < f.end) tripClock.push(mkCell(meta, cursor, f.end, tripQuality, {}));
    }
    tripClock.sort((a, b) => a.start - b.start);

    // Resolve open-ended sessions: end at next tie-on (same rod assumption) or trip end.
    const resolved = sessions.map((s, i) => {
      const next = sessions.slice(i + 1).find((n) => n.start > s.start);
      const end = s.end ?? (next ? next.start : t.endedAt);
      return { ...s, end: Math.min(end, t.endedAt) };
    });

    // Rod cells.
    const tripRod: Cell[] = [];
    if (resolved.length > 0) {
      for (const c of tripClock) {
        for (const s of resolved) {
          const a = Math.max(c.start, s.start);
          const b = Math.min(c.end, s.end);
          if (b <= a) continue;
          const q = worse(c.quality, s.source === 'tap' ? 'measured' : 'estimated');
          const cell = mkCell(meta, a, b, q, c.features, offerings.get(s.offeringId) ?? { id: s.offeringId, family: null, color: null });
          tripRod.push(cell);
          if (q === 'measured') dq.offeringHoursMeasured += cell.hours;
          else dq.offeringHoursEstimated += cell.hours;
        }
      }
    } else {
      dq.tripsWithoutOfferingLogs++;
    }

    // Attribute catches.
    const tripCatches = (catchByTrip.get(t.id) ?? []).slice().sort((a, b) => a.caughtAt - b.caughtAt || (a.id < b.id ? -1 : 1));
    if (tripClock.length === 0) {
      clock.push(...tripClock);
      continue;
    }
    for (const k of tripCatches) {
      const inside = tripClock.find((c) => k.caughtAt >= c.start && k.caughtAt < c.end);
      const target = inside ?? nearest(tripClock, k.caughtAt);
      if (!inside) {
        dq.catchesOutsideEffort++;
        questions.push({
          kind: 'catch_outside_effort',
          tripId: t.id,
          catchId: k.id,
          summary: 'This catch was logged outside your fishing time. Was the trip still going?',
        });
      }
      target.catches.push(k);

      if (resolved.length > 0) {
        const match = tripRod.find(
          (c) => k.caughtAt >= c.start && k.caughtAt < c.end && (k.offeringId === null || c.offering?.id === k.offeringId),
        );
        if (match) match.catches.push(k);
        else {
          dq.unmatchedOfferingCatches++;
          questions.push({
            kind: 'catch_offering_unmatched',
            tripId: t.id,
            catchId: k.id,
            summary: 'This fish came on a lure that was not tied on at the time. When did you switch to it?',
          });
        }
      }
    }

    // Legacy fallback (ADR-0015): no tie-on logs → split clock time equally among lures that caught.
    if (resolved.length === 0 && config.includeApportionedOfferingExposure) {
      const ids = [...new Set(tripCatches.map((k) => k.offeringId).filter((x): x is string => x !== null))].sort();
      if (ids.length > 0) {
        for (const c of tripClock) {
          for (const id of ids) {
            const cell = mkCell(meta, c.start, c.end, 'apportioned', c.features, offerings.get(id) ?? { id, family: null, color: null });
            cell.hours = c.hours / ids.length;
            cell.catches = c.catches.filter((k) => k.offeringId === id);
            dq.offeringHoursApportioned += cell.hours;
            tripRod.push(cell);
          }
        }
      }
    }

    clock.push(...tripClock);
    rod.push(...tripRod);
  }

  dq.measuredShare = dq.fishableHours > 0 ? measuredHours / dq.fishableHours : 0;
  return { trips: metas, clock, rod, questions, dataQuality: dq };
}

function mkCell(
  trip: TripMeta,
  start: number,
  end: number,
  quality: Quality,
  features: ConditionFeatures,
  offering: OfferingInput | null = null,
): Cell {
  return { trip, start, end, hours: (end - start) / HOUR, quality, features, offering, catches: [] as CatchInput[] };
}

function nearest(cells: Cell[], t: number): Cell {
  let best = cells[0]!;
  let bestD = Infinity;
  for (const c of cells) {
    const d = t < c.start ? c.start - t : t >= c.end ? t - c.end : 0;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
