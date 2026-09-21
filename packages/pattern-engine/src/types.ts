import type { EngineConfig } from './config';

export type Ms = number;
export type Season = 'spring' | 'summer' | 'fall' | 'winter';

/* ───────────────────────────── Inputs ───────────────────────────── */

/** How trip start/end/pauses were captured. Drives evidence quality (idea 2). */
export type EffortSource = 'timer' | 'manual' | 'reconstructed';

export interface TripInput {
  id: string;
  waterBodyId: string | null;
  startedAt: Ms;
  /** Completed trips only; the caller filters active and planned trips. */
  endedAt: Ms;
  effortSource: EffortSource;
  /** Species slug, 'mixed', or null (unknown). Idea 5. */
  targetSpecies?: string | null;
  /** Non-fishing time (travel, lunch, re-rigging). Idea 3. */
  pauses?: ReadonlyArray<{ start: Ms; end: Ms }>;
}

export interface ConditionFeatures {
  pressureTrend?: 'falling' | 'stable' | 'rising' | null;
  cloudPct?: number | null;
  windKph?: number | null;
  airTempC?: number | null;
  waterTempC?: number | null;
  /** Water temperature now minus 72h earlier. Idea 13/14 (trajectory). */
  waterTempDelta72hC?: number | null;
  /** Precipitation in the 48h before this hour. Idea 13/20. */
  precipPrev48hMm?: number | null;
  dischargeCms?: number | null;
  /** Percent change in discharge over the prior 24h. Idea 16/19. */
  dischargeDelta24hPct?: number | null;
  moonPhase?: number | null;
  minutesFromSunrise?: number | null;
  /** Signed minutes until actual sunset (negative = after sunset). Idea 22. */
  minutesToSunset?: number | null;
  season?: Season | null;
}

/** One enriched conditions row for an hour of a trip (existing trip-hour rows). */
export interface ConditionSlice {
  tripId: string;
  start: Ms;
  end: Ms;
  features: ConditionFeatures;
}

export interface OfferingInput {
  id: string;
  family: string | null;
  color: string | null;
}

/** "Tied on" interval. end = null means until the next tie-on or trip end. Idea 1. */
export interface OfferingSessionInput {
  tripId: string;
  offeringId: string;
  start: Ms;
  end: Ms | null;
  source: 'tap' | 'estimated';
}

export interface CatchInput {
  id: string;
  tripId: string;
  caughtAt: Ms;
  offeringId: string | null;
  species: string;
  lengthMm: number | null;
}

export type OutcomeKey = 'all' | 'quality' | `species:${string}`;
export type ScopeId = 'all' | string;

export interface HypothesisInput {
  id: string;
  /** Single dimension key or combo "a+b". */
  dimension: string;
  /** Bucket, or "x|y" for combos. */
  bucket: string;
  scopeId: ScopeId;
  outcome: OutcomeKey;
  expectation: 'better' | 'worse' | 'no_difference';
  createdAt: Ms;
}

export interface EngineInput {
  userId: string;
  /** Injected clock. The engine never reads Date.now() — determinism. */
  now: Ms;
  trips: ReadonlyArray<TripInput>;
  conditions: ReadonlyArray<ConditionSlice>;
  catches: ReadonlyArray<CatchInput>;
  offerings: ReadonlyArray<OfferingInput>;
  offeringSessions: ReadonlyArray<OfferingSessionInput>;
  previousRecords?: ReadonlyArray<FindingRecord>;
  hypotheses?: ReadonlyArray<HypothesisInput>;
  config?: Partial<EngineConfig>;
}

/* ───────────────────────────── Internal ───────────────────────────── */

export type Quality = 'measured' | 'estimated' | 'reconstructed' | 'apportioned';

export interface TripMeta {
  id: string;
  waterBodyId: string | null;
  startedAt: Ms;
  endedAt: Ms;
  week: number;
  targetSpecies: string | null;
  fishableHours: number;
  hasOfferingSessions: boolean;
}

/** Atomic exposure unit: constant trip, conditions, and (for rod cells) offering. */
export interface Cell {
  trip: TripMeta;
  start: Ms;
  end: Ms;
  hours: number;
  quality: Quality;
  features: ConditionFeatures;
  offering: OfferingInput | null;
  catches: CatchInput[];
  /** Per-cell bucket memo (perf: dimensions are evaluated once per cell, not once per pass). */
  memo?: Record<string, string | null>;
}

/* ───────────────────────────── Outputs ───────────────────────────── */

export type Tier = 'early' | 'promising' | 'solid';
export type LifecycleState =
  | 'hypothesis'
  | 'emerging'
  | 'repeated'
  | 'confirmed'
  | 'weakening'
  | 'retired';

export interface Check {
  id:
    | 'leave_best_trip_out'
    | 'survives_adjustment'
    | 'exposure_quality'
    | 'replicated_across_weeks'
    | 'search_corrected'
    | 'prospective';
  status: 'passed' | 'failed' | 'not_yet';
  detail: string;
}

export interface TripContribution {
  tripId: string;
  startedAt: Ms;
  catches: number;
  hours: number;
  /** Catches expected at your comparable-alternative rate. */
  expected: number;
}

export interface Confounder {
  dimension: string;
  adjustedMultiplier: number;
  /** Share of this finding's hours in the confounder's dominant bucket vs. its share overall. */
  dominantBucket: string;
  findingShare: number;
  populationShare: number;
}

export interface Gap {
  dimension: string;
  bucket: string;
  populationShare: number;
  findingShare: number;
}

export interface BucketStats {
  dimension: string;
  bucket: string;
  catches: number;
  hours: number;
  expected: number;
  exposedTrips: number;
  catchingTrips: number;
  distinctWeeks: number;
  /** Crude MH estimate before shrinkage; null when not testable. */
  rawLogRR: number | null;
  varLogRR: number | null;
  /** Shrunk (posterior) values. */
  logRR: number;
  postVar: number;
  multiplier: number;
  ci95: [number, number];
  pValue: number | null;
  qValue: number | null;
  /** Exact Poisson one-sided 95% upper bound on the multiplier (zero-catch evidence). */
  upperBound95: number;
  qualityScore: number;
  qualityHours: Record<Quality, number>;
  /** Share of population hours where this dimension was known (idea 5, missingness). */
  dimensionCoverage: number;
  strataLevel: 'water_season' | 'season' | 'none';
  testable: boolean;
  trips: TripContribution[];
}

export interface Finding {
  key: string;
  scopeId: ScopeId;
  outcome: OutcomeKey;
  kind: 'single' | 'combo';
  direction: 'positive' | 'negative';
  tier: Tier;
  stats: BucketStats;
  checks: Check[];
  confounders: Confounder[];
  gap: Gap | null;
  hoursToResolve: number | null;
  testsInFamily: number;
  /** Other dimension/buckets with identical evidence (e.g. your only chartreuse lure IS your only spinnerbait). */
  aliases: string[];
  lifecycle: LifecycleState;
  summary: string;
}

export interface DimensionInsight {
  scopeId: ScopeId;
  outcome: OutcomeKey;
  dimension: string;
  kind: 'little_difference';
  buckets: string[];
  summary: string;
}

export interface BlindSpot {
  dimension: string;
  bucket: string;
  share: number;
}

export interface WaterProfile {
  scopeId: ScopeId;
  trips: number;
  fishableHours: number;
  catchRate: number;
  skunkRate: number;
  medianMinutesToFirstFish: number | null;
  pNoFishBy60: number | null;
  pNoFishBy120: number | null;
  /** 90th percentile per-trip catch rate — the "upside". Idea 59. */
  p90TripRate: number;
}

export interface Family {
  scopeId: ScopeId;
  outcome: OutcomeKey;
  dispersion: number;
  testsRun: number;
  populationHours: number;
  populationTrips: number;
  findings: Finding[];
  insights: DimensionInsight[];
  blindSpots: BlindSpot[];
  profile: WaterProfile | null;
}

export interface HistoryEntry {
  at: Ms;
  from: LifecycleState | null;
  to: LifecycleState;
  reasons: string[];
}

/** Persisted between runs (pattern_findings table). */
export interface FindingRecord {
  key: string;
  direction: 'positive' | 'negative';
  state: LifecycleState;
  tier: Tier | null;
  multiplier: number;
  discoveredAt: Ms;
  /** Trips starting after this are independent of the discovery. Idea 45. */
  discoveryCutoff: Ms;
  weakeningSince: Ms | null;
  lastMaxTripStart: Ms;
  tripsAtOrBeforeLastMax: number;
  engineVersion: string;
  history: HistoryEntry[];
}

export interface HypothesisResult {
  id: string;
  verdict: 'supported' | 'contradicted' | 'unresolved' | 'insufficient';
  sinceCreated: HypothesisResult['verdict'];
  stats: BucketStats | null;
  prospectiveStats: BucketStats | null;
  hoursToResolve: number | null;
  gap: Gap | null;
  /** What future evidence would weaken it. Idea 44. */
  falsifier: string;
}

export interface Experiment {
  kind: 'resolve_finding' | 'resolve_hypothesis' | 'test_transfer' | 'fill_blind_spot';
  ref: string;
  scopeId: ScopeId;
  dimension: string;
  bucket: string;
  under: { dimension: string; bucket: string } | null;
  hoursToResolve: number | null;
  value: number;
  summary: string;
}

export interface DataQuestion {
  kind: 'catch_offering_unmatched' | 'catch_outside_effort';
  tripId: string;
  catchId: string;
  summary: string;
}

export interface DataQuality {
  fishableHours: number;
  measuredShare: number;
  offeringHoursMeasured: number;
  offeringHoursEstimated: number;
  offeringHoursApportioned: number;
  tripsWithoutOfferingLogs: number;
  unmatchedOfferingCatches: number;
  catchesOutsideEffort: number;
}

export interface EngineResult {
  engineVersion: string;
  computedAt: Ms;
  dataQuality: DataQuality;
  families: Family[];
  records: FindingRecord[];
  hypotheses: HypothesisResult[];
  experiments: Experiment[];
  questions: DataQuestion[];
}
