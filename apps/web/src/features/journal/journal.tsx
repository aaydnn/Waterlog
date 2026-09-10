import type { JournalEntry, Lure, WaterBody } from '@waterlog/schema'
import { useCallback, useEffect, useState } from 'react'
import type { JournalQuery } from '../../lib/api-client'
import type { WaterlogDb } from '../../lib/db'
import { getDb } from '../../lib/db'
import { cachedLures } from '../../lib/lures'
import { formatLength, formatWeight } from '../../lib/units'
import { cachedWaterBodies } from '../../lib/water-bodies'
import { SPECIES, speciesLabel } from '../capture/species'
import { CatchDetail } from './catch-detail'
import './journal.css'
import { fetchJournal, photoUrl } from './journal-data'

export interface JournalProps {
  db?: WaterlogDb
}

type Layout = 'grid' | 'list'

/** A date input's value ("2026-07-04") as an epoch-ms bound. `end` pushes it to the last
 * millisecond of that day so a single-day range includes the whole day. */
function dayBound(value: string, end: boolean): number | undefined {
  if (value === '') return undefined
  const ms = new Date(`${value}T00:00:00`).getTime()
  if (!Number.isFinite(ms)) return undefined
  return end ? ms + 24 * 60 * 60 * 1000 - 1 : ms
}

/** F3: reverse-chron photo grid + list, filtered by species, water, lure and date, with a
 * detail view. Photography-forward (packet §09) — the photo is the card. */
export function Journal({ db = getDb() }: JournalProps) {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [loading, setLoading] = useState(true)
  const [layout, setLayout] = useState<Layout>('grid')
  const [openCatchId, setOpenCatchId] = useState<string | null>(null)

  const [species, setSpecies] = useState('')
  const [waterBodyId, setWaterBodyId] = useState('')
  const [lureId, setLureId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [waters, setWaters] = useState<WaterBody[]>([])
  const [lures, setLures] = useState<Lure[]>([])

  useEffect(() => {
    // The filter menus name waters and lures, so they are scoped to the signed-in angler like
    // every other read of these caches — a menu is a list of somebody's spots.
    void Promise.all([cachedWaterBodies(db), cachedLures(db)]).then(([w, l]) => {
      setWaters(w)
      setLures(l)
    })
  }, [db])

  const query: JournalQuery = {
    species: species || undefined,
    water_body_id: waterBodyId || undefined,
    lure_id: lureId || undefined,
    from: dayBound(from, false),
    to: dayBound(to, true),
  }
  const queryKey = JSON.stringify(query)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchJournal(db, JSON.parse(queryKey) as JournalQuery).then((page) => {
      if (cancelled) return
      setEntries(page.entries)
      setCursor(page.next_cursor)
      setOffline(page.offline)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [db, queryKey])

  const loadMore = useCallback(async () => {
    if (!cursor) return
    const page = await fetchJournal(db, { ...(JSON.parse(queryKey) as JournalQuery), cursor })
    setEntries((current) => [...current, ...page.entries])
    setCursor(page.next_cursor)
  }, [cursor, db, queryKey])

  const filtered = species !== '' || waterBodyId !== '' || lureId !== '' || from !== '' || to !== ''

  function clearFilters() {
    setSpecies('')
    setWaterBodyId('')
    setLureId('')
    setFrom('')
    setTo('')
  }

  return (
    <section className="journal" aria-label="Catch journal">
      <div className="journal__bar">
        <div className="journal__filters">
          <select aria-label="Filter by species" value={species} onChange={(e) => setSpecies(e.target.value)}>
            <option value="">All species</option>
            {SPECIES.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.label}
              </option>
            ))}
          </select>

          <select aria-label="Filter by water" value={waterBodyId} onChange={(e) => setWaterBodyId(e.target.value)}>
            <option value="">All waters</option>
            {waters.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>

          <select aria-label="Filter by lure" value={lureId} onChange={(e) => setLureId(e.target.value)}>
            <option value="">All lures</option>
            {lures.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>

          <input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />

          {filtered && (
            <button type="button" className="journal__clear" onClick={clearFilters}>
              Clear
            </button>
          )}
        </div>

        <button
          type="button"
          className="journal__layout"
          aria-label={layout === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
          onClick={() => setLayout(layout === 'grid' ? 'list' : 'grid')}
        >
          {layout === 'grid' ? 'List' : 'Grid'}
        </button>
      </div>

      {offline && (
        <p className="journal__notice" role="status">
          Offline — showing what&rsquo;s on this device.
        </p>
      )}

      {loading && entries.length === 0 && <p className="journal__notice">Loading your journal…</p>}

      {!loading && entries.length === 0 && (
        <p className="journal__empty">
          {filtered
            ? 'No catches match those filters.'
            : 'Your first catch starts your dataset. Everything else is automatic.'}
        </p>
      )}

      <ul className={`journal__items journal__items--${layout}`}>
        {entries.map((entry) => (
          <li key={entry.id}>
            <button type="button" className="journal-card" onClick={() => setOpenCatchId(entry.id)}>
              <span className="journal-card__photo">
                {photoUrl(entry.photo_key) ? (
                  <img src={photoUrl(entry.photo_key)!} alt={speciesLabel(entry.species)} loading="lazy" />
                ) : (
                  <span className="journal-card__no-photo" aria-hidden="true" />
                )}
              </span>
              <span className="journal-card__body">
                <span className="journal-card__species">{speciesLabel(entry.species)}</span>
                <span className="journal-card__meta tabular-nums">
                  {new Date(entry.caught_at).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
                <span className="journal-card__meta">
                  {[
                    entry.water_body_name,
                    entry.lure_name,
                    formatLength(entry.length_mm),
                    formatWeight(entry.weight_g),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {cursor && (
        <button type="button" className="journal__more" onClick={() => void loadMore()}>
          Load more
        </button>
      )}

      {openCatchId && <CatchDetail catchId={openCatchId} onClose={() => setOpenCatchId(null)} />}
    </section>
  )
}
