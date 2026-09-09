import type { CatchDetail as CatchDetailPayload } from '@waterlog/schema'
import { useEffect, useState } from 'react'
import { ApiError, apiClient } from '../../lib/api-client'
import {
  formatDepth,
  formatFromSunrise,
  formatLength,
  formatMoonPhase,
  formatPressure,
  formatTemp,
  formatWeight,
  formatWind,
} from '../../lib/units'
import './catch-detail.css'
import { speciesLabel } from '../capture/species'
import { photoUrl } from './journal-data'

export interface CatchDetailProps {
  catchId: string
  onClose: () => void
}

interface Row {
  label: string
  value: string | null
}

/** Enrichment fills these in asynchronously and some of them never arrive for some waters
 * (Lake Oliphant has no gauge and never will — ADR-0008), so an absent reading is shown as
 * absent. Silence is data: it tells the angler which dimensions their patterns can use. */
function conditionRows(conditions: CatchDetailPayload['conditions']): Row[] {
  if (!conditions) return []
  const waterTemp = formatTemp(conditions.water_temp_c)
  const source = conditions.water_temp_source
  return [
    { label: 'Air', value: formatTemp(conditions.air_temp_c) },
    {
      label: 'Water',
      // How the temperature was obtained changes how much it's worth (ADR-0008), so it is
      // labelled rather than presented as one undifferentiated number.
      value: waterTemp && source ? `${waterTemp} (${source})` : waterTemp,
    },
    { label: 'Wind', value: formatWind(conditions.wind_kph) },
    { label: 'Cloud', value: conditions.cloud_pct === null ? null : `${Math.round(conditions.cloud_pct)}%` },
    { label: 'Rain', value: conditions.precip_mm === null ? null : `${conditions.precip_mm.toFixed(1)} mm` },
    {
      label: 'Pressure',
      value:
        formatPressure(conditions.pressure_hpa) && conditions.pressure_trend
          ? `${formatPressure(conditions.pressure_hpa)} · ${conditions.pressure_trend}`
          : formatPressure(conditions.pressure_hpa),
    },
    { label: 'Moon', value: formatMoonPhase(conditions.moon_phase) },
    { label: 'Sun', value: formatFromSunrise(conditions.minutes_from_sunrise) },
    {
      label: 'Pool level',
      value: conditions.pool_elevation_ft === null ? null : `${conditions.pool_elevation_ft.toFixed(1)} ft`,
    },
    {
      label: 'Tailwater',
      value: conditions.tailwater_ft === null ? null : `${conditions.tailwater_ft.toFixed(1)} ft`,
    },
    {
      label: 'Flow',
      value: conditions.discharge_cms === null ? null : `${conditions.discharge_cms.toFixed(2)} cms`,
    },
    { label: 'Season', value: conditions.season },
  ].filter((row) => row.value !== null)
}

/** What `workers/enrich` records about where each reading came from (its `sources` object). */
interface SourceMeta {
  weather?: boolean
  /** true, false (a gauge exists and the fetch failed), or 'none-in-range' (ADR-0008: no gauge
   * covers this water, and none ever will — Lake Oliphant is a 40-acre pond). */
  gauge?: boolean | string
  pool?: boolean
  water_temp?: string
}

function parseSourceMeta(raw: string | null): SourceMeta {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as SourceMeta
  } catch {
    return {}
  }
}

/** Why a reading is absent, in the angler's terms.
 *
 * "Missing" and "does not exist" are different facts and the panel must not blur them: a gauge
 * that failed today will fill in on a retry, while a water with no gauge in range will never
 * have one. Confusing the two teaches the angler to distrust the whole panel — and Epic 4 reads
 * the same distinction to decide which dimensions a pattern can use. */
function enrichmentNote(status: string, sourceMeta: string | null): string | null {
  const sources = parseSourceMeta(sourceMeta)

  if (status === 'failed') return 'Conditions could not be fetched for this catch.'

  const missing: string[] = []
  if (sources.weather === false) missing.push('weather')
  if (sources.gauge === false) missing.push('river level')
  if (sources.pool === false) missing.push('lake level')

  if (status === 'partial' || missing.length > 0) {
    const what = missing.length > 0 ? missing.join(' and ') : 'some readings'
    return `Couldn't reach ${what} for this catch — it'll fill in if the source comes back.`
  }

  if (sources.gauge === 'none-in-range') {
    return 'No gauge covers this water, so there is no level or flow to record.'
  }

  if (sources.gauge === 'not-applicable') {
    return 'Still water has no flow to measure.'
  }

  return null
}

/** F3 detail: the photo as the hero, then the fish, then every enriched condition. */
export function CatchDetail({ catchId, onClose }: CatchDetailProps) {
  const [detail, setDetail] = useState<CatchDetailPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    void apiClient
      .catchDetail(catchId)
      .then((payload) => {
        if (!cancelled) setDetail(payload)
      })
      .catch((error) => {
        if (cancelled) return
        setError(
          error instanceof ApiError && error.status === 401
            ? 'Sign in to see the full conditions for this catch.'
            : 'Offline — the full conditions for this catch are on the server.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [catchId])

  const rows = conditionRows(detail?.conditions ?? null)
  const note = detail ? enrichmentNote(detail.catch.enrich_status, detail.conditions?.source_meta ?? null) : null
  const photo = photoUrl(detail?.catch.photo_key ?? null)
  const fish = detail
    ? [formatLength(detail.catch.length_mm), formatWeight(detail.catch.weight_g), formatDepth(detail.catch.depth_m)]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <div role="dialog" aria-label="Catch detail" className="catch-detail">
        <button type="button" className="catch-detail__close" aria-label="Close catch detail" onClick={onClose}>
          ✕
        </button>

        {!detail && !error && <p className="catch-detail__notice">Loading…</p>}
        {error && <p className="catch-detail__notice">{error}</p>}

        {detail && (
          <>
            {photo && <img className="catch-detail__photo" src={photo} alt={speciesLabel(detail.catch.species)} />}
            <h2 className="catch-detail__species">{speciesLabel(detail.catch.species)}</h2>
            <p className="catch-detail__when tabular-nums">{new Date(detail.catch.caught_at).toLocaleString()}</p>
            {fish !== '' && <p className="catch-detail__fish tabular-nums">{fish}</p>}
            <p className="catch-detail__where">
              {[detail.water_body?.name, detail.lure?.name].filter(Boolean).join(' · ') || 'No water or lure recorded'}
            </p>
            {detail.catch.notes && <p className="catch-detail__notes">{detail.catch.notes}</p>}

            <h3 className="catch-detail__heading">Conditions</h3>
            {note && <p className="catch-detail__note">{note}</p>}
            {rows.length === 0 ? (
              <p className="catch-detail__notice">
                {detail.catch.enrich_status === 'pending'
                  ? 'Enriching conditions…'
                  : 'No conditions recorded for this catch.'}
              </p>
            ) : (
              <dl className="catch-detail__grid">
                {rows.map((row) => (
                  <div key={row.label} className="catch-detail__row">
                    <dt>{row.label}</dt>
                    <dd className="tabular-nums">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
      </div>
    </>
  )
}
