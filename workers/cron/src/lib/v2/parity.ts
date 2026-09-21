import type { Pattern } from '@waterlog/patterns'
import type { EngineResult, Finding } from '@waterlog/pattern-engine'

/**
 * The parity harness (brief §7, ADR-0017).
 *
 * Runs v1 and v2 over the same history and lines their cards up side by side. This is the gate
 * that decides whether v2 replaces v1, and it is deliberately not a pass/fail assertion: the rule
 * is that **every v1 card missing from v2 gets a written reason or becomes a failing test**, and
 * only a person looking at their own fishing can write that reason.
 *
 * So this produces the list and says as much as the engines can say about each row. Where v2 can
 * account for a disappearance it does. Where it cannot, the row is marked `unexplained`, which is
 * the queue of things a human has to rule on before the feed moves over.
 *
 * Pure: it takes two results and returns a report. Loading and printing live elsewhere.
 */

export type ParityStatus = 'both' | 'v1_only' | 'v2_only'

export interface ParitySide {
  multiplier: number
  catches: number
  hours: number
  trips: number
  /** v1 confidence or v2 tier — the same three words in both engines. */
  confidence: string
}

export interface ParityRow {
  scope: string
  dimension: string
  bucket: string
  status: ParityStatus
  v1: ParitySide | null
  v2: ParitySide | null
  /** v2's lifecycle state, which v1 has no equivalent of. */
  lifecycle: string | null
  /** Which stratum v2 could compare within — a broadened comparison is a weaker claim. */
  strataLevel: string | null
  /** What the engines can say about this row. Empty when nothing needs saying. */
  note: string
  /** A v1 card that vanished and that v2 cannot account for. The review queue. */
  unexplained: boolean
}

export interface ParityReport {
  rows: ParityRow[]
  summary: {
    both: number
    v1Only: number
    v2Only: number
    unexplained: number
    /** Of the rows in both, how many v2 pulled toward 1. ADR-0017 predicts nearly all of them. */
    shrunk: number
  }
}

/**
 * The two engines named the same dimensions differently. v1 calls them after the tackle box
 * (`lure_*`); v2 calls them after what was in the water (`offering_*`), because a session is an
 * offering whether or not it caught. Left unmapped, every lure pattern would read as a v1 card
 * that vanished *and* a v2 card that appeared — the loudest and most wrong rows in the gate.
 *
 * Every other dimension name is already shared: pressure_trend, sky, wind, water_temp, moon,
 * time_block, season.
 */
const V1_TO_V2_DIMENSION: Readonly<Record<string, string>> = {
  lure_family: 'offering_family',
  lure_color: 'offering_color',
}

/** Combos join with '+', so each side is mapped and the order is left alone — both engines build
 * a combo from an ordered pair, and reordering here would silently pair a dimension with the
 * wrong half of the bucket. */
function normalizeDimension(dimension: string): string {
  return dimension
    .split('+')
    .map((part) => V1_TO_V2_DIMENSION[part] ?? part)
    .join('+')
}

const keyOf = (scope: string, dimension: string, bucket: string) =>
  // JSON rather than a delimiter: a scope, dimension or bucket can contain most characters, and
  // an array encoding cannot collide however they are spelled.
  JSON.stringify([scope, dimension, bucket])

function v1Side(p: Pattern): ParitySide {
  return {
    multiplier: p.multiplier,
    catches: p.catches,
    hours: p.hours,
    trips: p.trips,
    confidence: p.confidence,
  }
}

function v2Side(f: Finding): ParitySide {
  return {
    multiplier: f.stats.multiplier,
    catches: f.stats.catches,
    hours: f.stats.hours,
    // Exposed trips, not catching trips (ADR-0017). This is a like-for-like column only in name:
    // v1's `trips` counts the trips that produced fish, and v2's counts the trips that fished it.
    trips: f.stats.exposedTrips,
    confidence: f.tier,
  }
}

/**
 * Why a v1 card is not in v2, as far as v2 can tell.
 *
 * v2 does not keep the candidates it rejected, so this can only speak from what it did produce.
 * The `little_difference` insight is the one case where it says so outright: the dimension was
 * examined and nothing in it separated. Everything else is honestly unexplained, and ADR-0017
 * names the four usual causes — shrinkage, a confounder, leave-best-trip-out, or BH correction —
 * for a person to choose between.
 */
function explainMissing(result: EngineResult, row: Pattern): { note: string; unexplained: boolean } {
  for (const family of result.families) {
    if (family.outcome !== 'all' || family.scopeId !== row.scope) continue
    for (const insight of family.insights) {
      if (insight.dimension === row.dimension) {
        return { note: `v2: no meaningful difference across ${row.dimension}`, unexplained: false }
      }
    }
  }

  const scopeRan = result.families.some((f) => f.outcome === 'all' && f.scopeId === row.scope)
  if (!scopeRan) {
    // The whole scope fell below v2's minimum exposure, so this is not a disagreement about the
    // pattern — v2 never looked at that water.
    return { note: `v2: scope "${row.scope}" had too little exposure to analyse`, unexplained: false }
  }

  return {
    note: 'v2 dropped it — needs a reason (shrinkage, confounder, leave-one-out, or BH) or a test',
    unexplained: true,
  }
}

/** How far v2 moved a multiplier that both engines kept, on the scale the ratio lives on. */
function describeMove(v1: number, v2: number): string {
  const toward = Math.abs(Math.log(v2)) < Math.abs(Math.log(v1))
  const direction = toward ? 'toward 1' : 'away from 1'
  return `${v1.toFixed(2)}x -> ${v2.toFixed(2)}x (${direction})`
}

export function compareEngines(v1Patterns: Pattern[], v2Result: EngineResult): ParityReport {
  // v1 only ever computed the all-species family, so that is the only like-for-like comparison.
  // v2's species and bigger-fish families have no v1 counterpart and are reported as v2-only.
  const v2Findings = new Map<string, Finding>()
  for (const family of v2Result.families) {
    for (const finding of family.findings) {
      if (family.outcome !== 'all') continue
      v2Findings.set(keyOf(finding.scopeId, finding.stats.dimension, finding.stats.bucket), finding)
    }
  }

  const rows: ParityRow[] = []
  const seen = new Set<string>()

  for (const pattern of v1Patterns) {
    const dimension = normalizeDimension(pattern.dimension)
    const key = keyOf(pattern.scope, dimension, pattern.bucket)
    seen.add(key)
    const finding = v2Findings.get(key)

    if (!finding) {
      const { note, unexplained } = explainMissing(v2Result, pattern)
      rows.push({
        scope: pattern.scope,
        dimension,
        bucket: pattern.bucket,
        status: 'v1_only',
        v1: v1Side(pattern),
        v2: null,
        lifecycle: null,
        strataLevel: null,
        note,
        unexplained,
      })
      continue
    }

    rows.push({
      scope: pattern.scope,
      dimension,
      bucket: pattern.bucket,
      status: 'both',
      v1: v1Side(pattern),
      v2: v2Side(finding),
      lifecycle: finding.lifecycle,
      strataLevel: finding.stats.strataLevel,
      note: describeMove(pattern.multiplier, finding.stats.multiplier),
      unexplained: false,
    })
  }

  for (const [key, finding] of v2Findings) {
    if (seen.has(key)) continue
    rows.push({
      scope: finding.scopeId,
      dimension: finding.stats.dimension,
      bucket: finding.stats.bucket,
      status: 'v2_only',
      v1: null,
      v2: v2Side(finding),
      lifecycle: finding.lifecycle,
      strataLevel: finding.stats.strataLevel,
      // A zero-catch negative is the headline new case: v1 had a minimum-catch floor that
      // suppressed exactly the finding "nothing here, where I'd expect fish".
      note: finding.stats.catches === 0 ? 'v2 only: zero-catch negative, which v1 could not surface' : 'v2 only',
      unexplained: false,
    })
  }

  // Stable order so two runs of the harness diff cleanly against each other.
  rows.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.dimension.localeCompare(b.dimension) ||
      a.bucket.localeCompare(b.bucket),
  )

  return {
    rows,
    summary: {
      both: rows.filter((r) => r.status === 'both').length,
      v1Only: rows.filter((r) => r.status === 'v1_only').length,
      v2Only: rows.filter((r) => r.status === 'v2_only').length,
      unexplained: rows.filter((r) => r.unexplained).length,
      shrunk: rows.filter(
        (r) => r.status === 'both' && Math.abs(Math.log(r.v2!.multiplier)) < Math.abs(Math.log(r.v1!.multiplier)),
      ).length,
    },
  }
}

/** The report as a table, for a terminal. One row per card, v1 on the left and v2 on the right. */
export function formatParityReport(report: ParityReport): string {
  const lines: string[] = []
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
  const num = (n: number | null) => (n === null ? '    -' : n.toFixed(2).padStart(5))

  lines.push(
    pad('SCOPE', 12) + pad('DIMENSION', 28) + pad('BUCKET', 22) + pad('V1', 12) + pad('V2', 12) + 'NOTE',
  )
  lines.push('-'.repeat(140))

  for (const row of report.rows) {
    const v1 = row.v1 ? `${num(row.v1.multiplier)}x ${row.v1.confidence.slice(0, 4)}` : '          -'
    const v2 = row.v2 ? `${num(row.v2.multiplier)}x ${row.v2.confidence.slice(0, 4)}` : '          -'
    lines.push(
      pad(row.scope, 12) +
        pad(row.dimension, 28) +
        pad(row.bucket, 22) +
        pad(v1, 12) +
        pad(v2, 12) +
        (row.unexplained ? '** ' : '') +
        row.note,
    )
  }

  const s = report.summary
  lines.push('')
  lines.push(
    `${s.both} in both, ${s.v1Only} v1-only, ${s.v2Only} v2-only. ` +
      `${s.shrunk}/${s.both} pulled toward 1. ${s.unexplained} unexplained.`,
  )
  if (s.unexplained > 0) {
    lines.push('')
    lines.push('Rows marked ** are the gate: each needs a written reason or a failing test before')
    lines.push('the feed moves from pattern_cache to pattern_findings.')
  }
  return lines.join('\n')
}
