import type { EngineResult, Tier } from '@waterlog/pattern-engine'

/**
 * Projecting a v2 `EngineResult` down onto v1's `pattern_cache` shape (ADR-0017, brief §7).
 *
 * This is the bridge that lets the shipped feed keep working while the engine underneath it
 * changes. It is deliberately lossy: `pattern_cache` has no column for a lifecycle state, a
 * confidence interval, a confounder or a receipt, so none of that survives the trip. Those live in
 * `pattern_findings`, and the feed moves over once the parity gate passes.
 *
 * Nothing calls this yet. v2 runs in shadow — it writes `pattern_findings` and leaves the live
 * feed to v1 — because the parity gate needs both engines' output over the same real history to
 * compare, and that is not possible if v2 has already overwritten v1's rows.
 */

export interface PatternCacheProjection {
  scope: string
  dimension: string
  bucket: string
  catches: number
  hours: number
  rate: number
  baseline_rate: number
  multiplier: number
  confidence: Tier
  trips: number
}

/**
 * One row per surfaced finding, in a stable order.
 *
 * Two filters, both of which drop findings that are real but cannot be represented:
 *
 * - **Outcome families other than `all`.** v2 computes per-species and bigger-fish families;
 *   `pattern_cache` has no outcome column, so a smallmouth finding and an all-species finding on
 *   the same scope, dimension and bucket would land as two rows the feed cannot tell apart. v1
 *   only ever computed the `all` family, so restricting to it is the honest projection rather
 *   than a loss.
 * - **Zero-exposure findings.** `rate` and `baseline_rate` are NOT NULL columns, and dividing by
 *   zero hours would store `Infinity` and render as a card claiming an infinite improvement.
 */
export function v2ToPatternCache(result: EngineResult): PatternCacheProjection[] {
  const rows: PatternCacheProjection[] = []
  for (const family of result.families) {
    if (family.outcome !== 'all') continue
    for (const finding of family.findings) {
      if (finding.stats.hours <= 0) continue
      rows.push({
        scope: finding.scopeId,
        dimension: finding.stats.dimension,
        bucket: finding.stats.bucket,
        catches: finding.stats.catches,
        hours: finding.stats.hours,
        rate: finding.stats.catches / finding.stats.hours,
        // v1's "baseline" was the angler's season-wide rate. v2 has no such thing — its comparison
        // is stratified — so the nearest true statement is the rate the bucket was expected to
        // produce given the alternatives, which is what `expected` already holds.
        baseline_rate: finding.stats.expected / finding.stats.hours,
        // The shrunk multiplier, not the raw one. ADR-0017 is explicit that the displayed number
        // is the one the engine believes.
        multiplier: finding.stats.multiplier,
        confidence: finding.tier,
        // Exposed trips, not catching trips: how many separate times the angler put this in the
        // water is the question, and a trip that got skunked on it is evidence about it.
        trips: finding.stats.exposedTrips,
      })
    }
  }
  return rows
}
