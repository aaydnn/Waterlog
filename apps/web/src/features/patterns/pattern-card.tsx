import { confidenceLabel, describeConfidence, describePattern, describeSampleSize } from '@waterlog/patterns'
import type { PatternCard as PatternCardData, PatternTeaser } from '@waterlog/schema'

/**
 * The card packet §09 specifies: a plain-English statement, a multiplier chip, a sparkline, a
 * sample-size footer and a confidence badge.
 *
 * The words come from @waterlog/patterns, not from here, so the cache keeps storing a dimension
 * and a bucket rather than prose and the vocabulary has exactly one home.
 */

/** A bar per unit of multiplier against the baseline at 1. Not a time series — there is no time
 * series in `pattern_cache` — so it shows the one comparison the card is actually making. */
function MultiplierBar({ multiplier }: { multiplier: number }) {
  const lift = multiplier >= 1
  // The baseline sits a third of the way across, so a collapse has room to be seen shrinking and
  // a lift has room to grow.
  const baselineAt = 33
  const width = lift
    ? Math.min(67, (multiplier - 1) * 22)
    : Math.min(baselineAt, (1 - multiplier) * baselineAt)
  return (
    <span className="pattern-card__bar" aria-hidden="true">
      <span className="pattern-card__bar-baseline" style={{ left: `${baselineAt}%` }} />
      <span
        className={`pattern-card__bar-fill pattern-card__bar-fill--${lift ? 'lift' : 'drop'}`}
        style={
          lift
            ? { left: `${baselineAt}%`, width: `${width}%` }
            : { left: `${baselineAt - width}%`, width: `${width}%` }
        }
      />
    </span>
  )
}

export function PatternCard({ pattern }: { pattern: PatternCardData }) {
  const lift = pattern.multiplier >= 1
  return (
    <li className="pattern-card">
      <div className="pattern-card__head">
        <span
          className={`pattern-card__chip pattern-card__chip--${lift ? 'lift' : 'drop'} tabular-nums`}
        >
          {pattern.multiplier.toFixed(1)}×
        </span>
        <span className={`pattern-card__badge pattern-card__badge--${pattern.confidence}`}>
          {describeConfidence(pattern)}
        </span>
      </div>

      <p className="pattern-card__statement">{describePattern(pattern)}</p>

      <MultiplierBar multiplier={pattern.multiplier} />

      <p className="pattern-card__footer tabular-nums">
        {describeSampleSize(pattern)}
        {pattern.scope_name ? <span className="pattern-card__scope"> · {pattern.scope_name}</span> : null}
      </p>
    </li>
  )
}

/**
 * What a free angler sees: a card of the right shape, with the kind of thing it is about and how
 * well replicated it is. There is nothing to un-blur — the server never sent the bucket or the
 * multiplier (ADR-0016) — so the bars below are decoration, not hidden text.
 */
export function TeaserCard({ teaser }: { teaser: PatternTeaser }) {
  return (
    <li className="pattern-card pattern-card--locked" aria-label={`Locked pattern about ${teaser.dimension_label}`}>
      <div className="pattern-card__head">
        <span className="pattern-card__chip pattern-card__chip--locked" aria-hidden="true">
          ?.?×
        </span>
        <span className={`pattern-card__badge pattern-card__badge--${teaser.confidence}`}>
          {confidenceLabel(teaser.confidence)}
        </span>
      </div>

      <p className="pattern-card__statement pattern-card__statement--locked">
        Something in <strong>{teaser.dimension_label}</strong> is changing how often you catch.
      </p>

      <span className="pattern-card__blur" aria-hidden="true">
        <span className="pattern-card__blur-line" />
        <span className="pattern-card__blur-line pattern-card__blur-line--short" />
      </span>
    </li>
  )
}
