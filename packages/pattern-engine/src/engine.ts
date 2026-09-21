import type { CountFn } from './analyze';
import { DEFAULT_CONFIG, type EngineConfig } from './config';
import { buildExposure } from './exposure';
import { analyzeFamily, type FamilyWork } from './family';
import { evaluateHypotheses, suggestExperiments } from './hypotheses';
import { updateLifecycle } from './lifecycle';
import { quantile } from './stats/distributions';
import type { Cell, EngineInput, EngineResult, OutcomeKey, ScopeId } from './types';
import { ENGINE_VERSION } from './version';

interface Outcome {
  key: OutcomeKey;
  includeTrip: (c: Cell) => boolean;
  count: CountFn;
}

function outcomes(input: EngineInput, config: EngineConfig): Outcome[] {
  const out: Outcome[] = [{ key: 'all', includeTrip: () => true, count: (c) => c.catches.length }];

  const bySpecies = new Map<string, number>();
  for (const k of input.catches) bySpecies.set(k.species, (bySpecies.get(k.species) ?? 0) + 1);
  for (const [species, n] of [...bySpecies.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n < config.minSpeciesCatches) continue;
    out.push({
      key: `species:${species}`,
      // Trips aimed at a different species are not exposure for this one (idea 5).
      includeTrip: (c) => c.trip.targetSpecies === null || c.trip.targetSpecies === 'mixed' || c.trip.targetSpecies === species,
      count: (c) => c.catches.filter((k) => k.species === species).length,
    });
  }

  const thresholds = new Map<string, number>();
  const lengths = new Map<string, number[]>();
  for (const k of input.catches) if (k.lengthMm !== null) lengths.set(k.species, [...(lengths.get(k.species) ?? []), k.lengthMm]);
  for (const [species, ls] of lengths) if (ls.length >= config.minLengthSamples) thresholds.set(species, quantile(ls, config.qualityPercentile)!);
  if (thresholds.size > 0) {
    const unmeasured = new Set(
      input.catches.filter((k) => thresholds.has(k.species) && k.lengthMm === null).map((k) => k.tripId),
    );
    out.push({
      key: 'quality',
      // Trips with unmeasured fish can't say whether a big one was caught; excluded rather than guessed.
      includeTrip: (c) => !unmeasured.has(c.trip.id),
      count: (c) => c.catches.filter((k) => k.lengthMm !== null && thresholds.has(k.species) && k.lengthMm >= thresholds.get(k.species)!).length,
    });
  }
  return out;
}

export function runEngine(input: EngineInput): EngineResult {
  const config: EngineConfig = { ...DEFAULT_CONFIG, ...input.config };
  const exposure = buildExposure(input, config);
  const works: FamilyWork[] = [];

  const scopes: ScopeId[] = ['all'];
  const waterHours = new Map<string, number>();
  for (const c of exposure.clock) if (c.trip.waterBodyId) waterHours.set(c.trip.waterBodyId, (waterHours.get(c.trip.waterBodyId) ?? 0) + c.hours);
  for (const [w, h] of [...waterHours.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (h >= config.minScopeHours) scopes.push(w);

  const totalHours = exposure.clock.reduce((s, c) => s + c.hours, 0);
  if (totalHours >= config.minScopeHours) {
    for (const o of outcomes(input, config)) {
      // Species and bigger-fish families run across all waters only — bounded CPU per user.
      const scopeList = o.key === 'all' ? scopes : (['all'] as ScopeId[]);
      for (const scopeId of scopeList) {
        const inScope = (c: Cell) => (scopeId === 'all' || c.trip.waterBodyId === scopeId) && o.includeTrip(c);
        works.push(analyzeFamily(scopeId, o.key, exposure.clock.filter(inScope), exposure.rod.filter(inScope), o.count, config));
      }
    }
  }

  const records = updateLifecycle(works, input.previousRecords ?? [], input.now, config);
  const hypotheses = evaluateHypotheses(input.hypotheses ?? [], works, config);
  const experiments = suggestExperiments(works, hypotheses, input.hypotheses ?? [], input.now);

  return {
    engineVersion: ENGINE_VERSION,
    computedAt: input.now,
    dataQuality: exposure.dataQuality,
    families: works.map((w) => w.family),
    records,
    hypotheses,
    experiments,
    questions: exposure.questions,
  };
}
