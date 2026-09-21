import { aggregate, bucketStats, type CountFn } from './analyze';
import type { EngineConfig } from './config';
import { resolveDimension } from './dimensions';
import type { FamilyWork } from './family';
import { binomTail } from './stats/distributions';
import type { BucketStats, Cell, Finding, FindingRecord, HistoryEntry, LifecycleState, Ms } from './types';
import { ENGINE_VERSION } from './version';

const DAY = 86_400_000;
const MAX_HISTORY = 20;

/** Re-run one bucket on a subset of trips (prospective window, recent window, since-belief window). */
export function statsOnSubset(
  work: FamilyWork,
  dimension: string,
  bucket: string,
  keep: (c: Cell) => boolean,
): BucketStats | null {
  const dim = resolveDimension(dimension);
  if (!dim) return null;
  const cells = (dim.population === 'rod' ? work.rod : work.clock).filter(keep);
  return bucketStats(aggregate(cells, dim, work.count), bucket, work.ctx);
}

export interface Prospective {
  status: 'not_yet' | 'passed' | 'failed';
  stats: BucketStats | null;
}

export function prospective(work: FamilyWork, f: Finding, cutoff: Ms, config: EngineConfig): Prospective {
  const s = statsOnSubset(work, f.stats.dimension, f.stats.bucket, (c) => c.trip.startedAt > cutoff);
  if (!s || !s.testable || s.rawLogRR === null || s.exposedTrips < config.minProspectiveTrips) return { status: 'not_yet', stats: s };
  const sameSide = f.direction === 'positive' ? s.rawLogRR > 0 : s.rawLogRR < 0;
  const clearlyOpposite = f.direction === 'positive' ? s.ci95[1] < 1 : s.ci95[0] > 1;
  if (sameSide) return { status: 'passed', stats: s };
  return { status: clearlyOpposite || Math.abs(s.rawLogRR) >= Math.log(1.25) ? 'failed' : 'not_yet', stats: s };
}

/** F17 decay watch: season-matched recent vs. prior windows, exact conditional binomial on O with E offsets. */
export function decayTest(work: FamilyWork, f: Finding, now: Ms, config: EngineConfig): { declined: boolean; p: number | null } {
  const recentStart = now - config.decayWindowDays * DAY;
  const recent = statsOnSubset(work, f.stats.dimension, f.stats.bucket, (c) => c.trip.startedAt >= recentStart);
  if (!recent || recent.exposedTrips < config.minProspectiveTrips || recent.expected <= 0) return { declined: false, p: null };
  const recentSeasons = new Set(
    (resolveDimension(f.stats.dimension)!.population === 'rod' ? work.rod : work.clock)
      .filter((c) => c.trip.startedAt >= recentStart)
      .map((c) => c.features.season ?? '?'),
  );
  const prior = statsOnSubset(
    work,
    f.stats.dimension,
    f.stats.bucket,
    (c) => c.trip.startedAt < recentStart && recentSeasons.has(c.features.season ?? '?'),
  );
  if (!prior || prior.expected <= 0 || prior.exposedTrips < config.minProspectiveTrips) return { declined: false, p: null };
  const n = recent.catches + prior.catches;
  if (n < 5) return { declined: false, p: null };
  // Quasi-binomial: shrink counts by dispersion so lumpy trips don't masquerade as decline.
  const phi = work.ctx.phi;
  const pNull = recent.expected / (recent.expected + prior.expected);
  const p = binomTail(Math.round(recent.catches / phi), Math.round(n / phi), pNull, f.direction === 'positive' ? 'le' : 'ge');
  // Winner's curse guard: the discovery window is inflated by selection, so a lower recent rate alone is
  // expected. Only call it decay when the recent window ALSO no longer clears the effect threshold.
  const recentStillMeaningful =
    f.direction === 'positive' ? recent.multiplier >= config.minEffect : recent.multiplier <= 1 / config.minEffect;
  return { declined: p < 0.05 && !recentStillMeaningful, p };
}

export function updateLifecycle(
  works: ReadonlyArray<FamilyWork>,
  previous: ReadonlyArray<FindingRecord>,
  now: Ms,
  config: EngineConfig,
): FindingRecord[] {
  const prevByKey = new Map(previous.map((r) => [r.key, r]));
  const out = new Map<string, FindingRecord>();

  for (const work of works) {
    const maxStart = Math.max(0, ...work.clock.map((c) => c.trip.startedAt));
    const tripStarts = [...new Set(work.clock.map((c) => `${c.trip.id}@${c.trip.startedAt}`))].map((x) => Number(x.split('@')[1]));
    const current = new Map(work.family.findings.map((f) => [f.key, f]));
    const keys = new Set([...current.keys(), ...previous.filter((r) => r.key.startsWith(`${work.family.scopeId}::${work.family.outcome}::`)).map((r) => r.key)]);

    for (const key of [...keys].sort()) {
      const f = current.get(key);
      const r = prevByKey.get(key);
      const reasons: string[] = [];

      if (!r) {
        if (!f) continue;
        const state: LifecycleState = f.tier === 'early' ? 'hypothesis' : f.tier === 'solid' ? 'repeated' : 'emerging';
        f.lifecycle = state;
        f.checks.push({ id: 'prospective', status: 'not_yet', detail: 'Waiting for trips after this was discovered.' });
        out.set(key, {
          key,
          direction: f.direction,
          state,
          tier: f.tier,
          multiplier: f.stats.multiplier,
          discoveredAt: now,
          discoveryCutoff: maxStart,
          weakeningSince: null,
          lastMaxTripStart: maxStart,
          tripsAtOrBeforeLastMax: tripStarts.length,
          engineVersion: ENGINE_VERSION,
          history: [{ at: now, from: null, to: state, reasons: ['discovered'] }],
        });
        continue;
      }

      // What changed my mind? (idea 63)
      const added = tripStarts.filter((t) => t > r.lastMaxTripStart).length;
      const priorCount = tripStarts.filter((t) => t <= r.lastMaxTripStart).length;
      if (added > 0) reasons.push(`new_trips:${added}`);
      if (priorCount !== r.tripsAtOrBeforeLastMax) reasons.push('earlier_logs_edited');
      if (r.engineVersion !== ENGINE_VERSION) reasons.push('engine_updated');

      if (!f) {
        const next: LifecycleState = r.state === 'retired' ? 'retired' : weakenOrRetire(r, now, config);
        out.set(key, transition(r, next, null, r.multiplier, now, [...reasons, 'below_threshold'], maxStart, tripStarts.length));
        continue;
      }

      if (f.direction !== r.direction) {
        f.lifecycle = 'hypothesis';
        f.checks.push({ id: 'prospective', status: 'not_yet', detail: 'Direction reversed; evaluating afresh.' });
        const rec = transition(r, 'hypothesis', f.tier, f.stats.multiplier, now, [...reasons, 'direction_reversed'], maxStart, tripStarts.length);
        out.set(key, { ...rec, direction: f.direction, discoveredAt: now, discoveryCutoff: maxStart });
        continue;
      }

      if (r.tier !== f.tier) reasons.push(`tier:${r.tier ?? 'none'}->${f.tier}`);
      if (Math.abs(Math.log(f.stats.multiplier) - Math.log(r.multiplier)) >= Math.log(1.2)) reasons.push('effect_changed');

      if (r.state === 'retired') {
        // Pattern expiration and revival (idea 76): evidence resets; prospective clock restarts now.
        const next: LifecycleState = f.tier === 'early' ? 'hypothesis' : f.tier === 'solid' ? 'repeated' : 'emerging';
        f.lifecycle = next;
        f.checks.push({ id: 'prospective', status: 'not_yet', detail: 'Came back after being retired; waiting for new trips.' });
        const rec = transition(r, next, f.tier, f.stats.multiplier, now, [...reasons, 'revived'], maxStart, tripStarts.length);
        out.set(key, { ...rec, discoveryCutoff: maxStart });
        continue;
      }

      const pro = prospective(work, f, r.discoveryCutoff, config);
      const decay = decayTest(work, f, now, config);
      f.checks.push({
        id: 'prospective',
        status: pro.status,
        detail:
          pro.status === 'passed'
            ? `Held up on ${pro.stats!.exposedTrips} trips since it was found.`
            : pro.status === 'failed'
              ? `Hasn't held up on ${pro.stats!.exposedTrips} trips since it was found.`
              : 'Waiting for more trips after this was discovered.',
      });

      let next: LifecycleState;
      if (decay.declined || pro.status === 'failed') {
        reasons.push(decay.declined ? 'recent_decline' : 'prospective_failed');
        next = weakenOrRetire(r, now, config);
      } else if (pro.status === 'passed' && f.tier !== 'early') {
        next = 'confirmed';
        if (r.state !== 'confirmed') reasons.push('prospective_passed');
      } else if (f.tier === 'early') {
        next = r.state === 'hypothesis' ? 'hypothesis' : weakenOrRetire(r, now, config);
        if (next !== 'hypothesis') reasons.push('evidence_softened');
      } else if (r.state === 'confirmed') {
        next = 'confirmed';
      } else {
        next = f.tier === 'solid' ? 'repeated' : 'emerging';
      }
      f.lifecycle = next;
      out.set(key, transition(r, next, f.tier, f.stats.multiplier, now, reasons, maxStart, tripStarts.length));
    }
  }
  // Records for families not evaluated this run (e.g., a water that fell below minScopeHours) carry over untouched.
  for (const r of previous) if (!out.has(r.key)) out.set(r.key, r);
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

function weakenOrRetire(r: FindingRecord, now: Ms, c: EngineConfig): LifecycleState {
  if (r.state === 'weakening' && r.weakeningSince !== null && now - r.weakeningSince >= c.retireAfterDays * DAY) return 'retired';
  return 'weakening';
}

function transition(
  r: FindingRecord,
  to: LifecycleState,
  tier: FindingRecord['tier'],
  multiplier: number,
  now: Ms,
  reasons: string[],
  maxStart: Ms,
  tripCount: number,
): FindingRecord {
  // Record state changes, and also material evidence changes without a state change ("what changed my mind").
  const material = reasons.some((x) => !x.startsWith('new_trips') && x !== 'below_threshold');
  const history: HistoryEntry[] =
    to !== r.state || material ? [...r.history, { at: now, from: r.state, to, reasons }].slice(-MAX_HISTORY) : r.history;
  return {
    ...r,
    state: to,
    tier,
    multiplier,
    weakeningSince: to === 'weakening' ? (r.state === 'weakening' ? r.weakeningSince : now) : null,
    lastMaxTripStart: maxStart,
    tripsAtOrBeforeLastMax: tripCount,
    engineVersion: ENGINE_VERSION,
    history,
  };
}

export type { CountFn };
