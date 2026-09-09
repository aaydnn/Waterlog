import type { Stats } from '@waterlog/schema'
import { useEffect, useState } from 'react'
import { ApiError, apiClient } from '../../lib/api-client'
import { speciesLabel } from '../capture/species'
import './stats-view.css'

/** "3 of your 11 trips came up empty" — the packet's voice rule: every number gets a
 * plain-English sentence, and a rate is honest only when the skunks are in the denominator. */
function summarySentence(stats: Stats): string {
  const { catches, trips, hours_on_water, skunked_trips } = stats.totals
  if (trips === 0) return 'Nothing logged yet — your first trip starts the record.'
  if (catches === 0) return `${trips} ${trips === 1 ? 'trip' : 'trips'} logged, no catches yet.`

  const perHour = hours_on_water > 0 ? (catches / hours_on_water).toFixed(2) : null
  const rate = perHour ? ` — ${perHour} fish per hour on the water` : ''
  const skunks = skunked_trips > 0 ? `, ${skunked_trips} of them without a fish` : ''
  return `${catches} ${catches === 1 ? 'catch' : 'catches'} across ${trips} ${
    trips === 1 ? 'trip' : 'trips'
  }${skunks}${rate}.`
}

function monthLabel(month: string): string {
  const [year, m] = month.split('-')
  const date = new Date(Number(year), Number(m) - 1, 1)
  return date.toLocaleDateString([], { month: 'short', year: 'numeric' })
}

interface BarRow {
  key: string
  label: string
  value: number
  detail?: string
}

/** A bar per row, scaled to the largest — enough to read a breakdown at a glance without
 * pulling in a chart library for what is, at free tier, four numbers. */
function Breakdown({ title, rows, empty }: { title: string; rows: BarRow[]; empty: string }) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0)
  return (
    <section className="stats__section">
      <h3 className="stats__heading">{title}</h3>
      {rows.length === 0 ? (
        <p className="stats__empty">{empty}</p>
      ) : (
        <ul className="stats__bars">
          {rows.map((row) => (
            <li key={row.key} className="stats__bar-row">
              <span className="stats__bar-label">{row.label}</span>
              <span className="stats__bar-track" aria-hidden="true">
                <span className="stats__bar-fill" style={{ width: `${max === 0 ? 0 : (row.value / max) * 100}%` }} />
              </span>
              <span className="stats__bar-value tabular-nums">
                {row.value}
                {row.detail ? <span className="stats__bar-detail"> {row.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** F4, free tier: totals and simple breakdowns by species, month and water. Condition
 * correlations are the Pro pattern engine (Epic 4) and are deliberately absent. */
export function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void apiClient
      .stats()
      .then((payload) => {
        if (!cancelled) setStats(payload)
      })
      .catch((error) => {
        if (cancelled) return
        // 401 means the session lapsed, not that the phone lost signal (the app-level handler
        // is already returning to sign-in) — don't blame the connection for it.
        setError(
          error instanceof ApiError && error.status === 401
            ? 'Sign in to see your stats.'
            : 'Offline — stats are computed on the server.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <p className="stats__empty">{error}</p>
  if (!stats) return <p className="stats__empty">Loading your stats…</p>

  const totals: Array<{ label: string; value: string }> = [
    { label: 'Catches', value: String(stats.totals.catches) },
    { label: 'Trips', value: String(stats.totals.trips) },
    { label: 'Hours', value: stats.totals.hours_on_water.toFixed(1) },
    { label: 'Species', value: String(stats.totals.species) },
  ]

  return (
    <section className="stats" aria-label="Your stats">
      <p className="stats__summary">{summarySentence(stats)}</p>

      <ul className="stats__totals">
        {totals.map((total) => (
          <li key={total.label} className="stats__total">
            <span className="stats__total-value tabular-nums">{total.value}</span>
            <span className="stats__total-label">{total.label}</span>
          </li>
        ))}
      </ul>

      <Breakdown
        title="By species"
        empty="No catches yet."
        rows={stats.by_species.map((row) => ({
          key: row.species,
          label: speciesLabel(row.species),
          value: row.catches,
        }))}
      />

      <Breakdown
        title="By month"
        empty="No trips yet."
        rows={stats.by_month.map((row) => ({
          key: row.month,
          label: monthLabel(row.month),
          value: row.catches,
          detail: `· ${row.trips} ${row.trips === 1 ? 'trip' : 'trips'}`,
        }))}
      />

      <Breakdown
        title="By water"
        empty="No trips yet."
        rows={stats.by_water.map((row) => ({
          key: row.water_body_id ?? 'no-water',
          label: row.water_body_name ?? 'No water recorded',
          value: row.catches,
          detail: `· ${row.trips} ${row.trips === 1 ? 'trip' : 'trips'}`,
        }))}
      />
    </section>
  )
}
