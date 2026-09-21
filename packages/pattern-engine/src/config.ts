export interface EngineConfig {
  /** Minimum fishable hours in a bucket before it can be tested at all. */
  minBucketHours: number;
  /** Minimum distinct trips with exposure to the bucket (pseudo-replication guard). */
  minExposedTrips: number;
  /** Minimum catches for a positive finding. Negatives may surface with fewer (zero-catch evidence). */
  minCatches: number;
  /** Expected catches (at your comparable-alternative rate) needed before a low/zero-catch negative can surface. */
  minExpectedForNegative: number;
  /** Symmetric effect threshold applied to the SHRUNK multiplier (>= x or <= 1/x). */
  minEffect: number;
  /** Prior sd on ln(rate ratio). ln(2)/1.96 ≈ 0.354: before evidence, 95% of true effects lie within 0.5x–2x. */
  priorSdLog: number;
  /** Equivalence margin for "little difference" (CI within 1/x .. x). */
  equivalenceMargin: number;
  /** Combo must beat its strongest parent (log scale) by this ratio to surface. Spec §8: 1.25. */
  comboMustBeatParentBy: number;
  /** Hard cap on combo dimensions tested per family (false-discovery budget). */
  maxComboDimensions: number;
  /** BH q-value ceilings per tier. */
  qPromising: number;
  qSolid: number;
  /** Evidence-quality score floors per tier (hours-weighted, 0..1). */
  qualityPromising: number;
  qualitySolid: number;
  /** Solid requires replication across this many distinct ISO weeks. */
  solidMinWeeks: number;
  solidMinExposedTrips: number;
  /** Scope (water body) must have this many fishable hours to be analyzed on its own. */
  minScopeHours: number;
  /** Species outcome family requires this many catches of the species. */
  minSpeciesCatches: number;
  /** Quality ("bigger fish") threshold needs this many measured catches of a species. */
  minLengthSamples: number;
  qualityPercentile: number;
  /** Trips after discovery needed before prospective confirmation can be judged. */
  minProspectiveTrips: number;
  /** Recent window for decay watch (F17). */
  decayWindowDays: number;
  /** A weakening finding with no recovery for this long is retired. */
  retireAfterDays: number;
  /** Include apportioned (legacy, no tie-on logs) lure exposure. Capped by quality score. */
  includeApportionedOfferingExposure: boolean;
  /** Top findings examined for competing explanations. */
  maxConfounderChecks: number;
  /** Dispersion clamp. */
  maxDispersion: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  minBucketHours: 3,
  minExposedTrips: 3,
  minCatches: 3,
  minExpectedForNegative: 4,
  minEffect: 1.4,
  priorSdLog: Math.log(2) / 1.96,
  equivalenceMargin: 1.25,
  comboMustBeatParentBy: 1.25,
  maxComboDimensions: 16,
  qPromising: 0.1,
  qSolid: 0.05,
  qualityPromising: 0.5,
  qualitySolid: 0.7,
  solidMinWeeks: 3,
  solidMinExposedTrips: 5,
  minScopeHours: 10,
  minSpeciesCatches: 10,
  minLengthSamples: 8,
  qualityPercentile: 0.75,
  minProspectiveTrips: 3,
  decayWindowDays: 365,
  retireAfterDays: 60,
  includeApportionedOfferingExposure: true,
  maxConfounderChecks: 12,
  maxDispersion: 8,
};

export const QUALITY_SCORE = {
  measured: 1,
  estimated: 0.7,
  reconstructed: 0.5,
  apportioned: 0.4,
} as const;
