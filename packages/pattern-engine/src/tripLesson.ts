import { DEFAULT_CONFIG } from './config';
import { buildExposure } from './exposure';
import { poissonCdf } from './stats/distributions';
import type { DataQuestion, EngineInput, EngineResult } from './types';

export interface TripLesson {
  tripId: string;
  hours: number;
  catches: number;
  strengthened: Array<{ key: string; summary: string; catches: number; expected: number }>;
  weakened: Array<{ key: string; summary: string; catches: number; expected: number }>;
  /** Dimensions this trip can't speak to because only one option was used (e.g. one color). */
  saysLittleAbout: string[];
  measuredOfferingShare: number;
  questions: DataQuestion[];
}

/** One useful post-trip lesson (idea 67). Call with the result computed AFTER the trip was added. */
export function summarizeTrip(history: EngineInput, result: EngineResult, tripId: string): TripLesson {
  const exposure = buildExposure(history, { ...DEFAULT_CONFIG, ...history.config });
  const clock = exposure.clock.filter((c) => c.trip.id === tripId);
  const rod = exposure.rod.filter((c) => c.trip.id === tripId);
  const strengthened: TripLesson['strengthened'] = [];
  const weakened: TripLesson['weakened'] = [];

  for (const fam of result.families) {
    if (fam.outcome !== 'all') continue;
    for (const f of fam.findings) {
      if (f.tier === 'early') continue;
      const t = f.stats.trips.find((x) => x.tripId === tripId);
      if (!t || t.expected < 0.5) continue;
      const row = { key: f.key, summary: f.summary, catches: t.catches, expected: t.expected };
      if (f.direction === 'positive') {
        if (t.catches > t.expected) strengthened.push(row);
        else if (poissonCdf(t.catches, t.expected * f.stats.multiplier) < 0.15) weakened.push(row);
      } else if (t.catches < t.expected && t.expected >= 1) strengthened.push(row);
      else if (t.catches >= 2 && t.catches > 1.5 * t.expected) weakened.push(row);
    }
  }
  const byGap = (x: { catches: number; expected: number }, y: { catches: number; expected: number }) =>
    Math.abs(y.catches - y.expected) - Math.abs(x.catches - x.expected);

  const saysLittleAbout: string[] = [];
  for (const key of ['offering_family', 'offering_color'] as const) {
    const vals = new Set(rod.map((c) => (key === 'offering_family' ? c.offering?.family : c.offering?.color)).filter(Boolean));
    if (rod.length > 0 && vals.size === 1) saysLittleAbout.push(key);
  }
  const rodHours = rod.reduce((s, c) => s + c.hours, 0);
  return {
    tripId,
    hours: clock.reduce((s, c) => s + c.hours, 0),
    catches: clock.reduce((s, c) => s + c.catches.length, 0),
    strengthened: strengthened.sort(byGap).slice(0, 3),
    weakened: weakened.sort(byGap).slice(0, 3),
    saysLittleAbout,
    measuredOfferingShare: rodHours > 0 ? rod.filter((c) => c.quality === 'measured').reduce((s, c) => s + c.hours, 0) / rodHours : 0,
    questions: exposure.questions.filter((q) => q.tripId === tripId),
  };
}
