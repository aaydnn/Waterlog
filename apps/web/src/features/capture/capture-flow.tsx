import type { Lure } from '@waterlog/schema'
import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../lib/api-client'
import type { WaterlogDb } from '../../lib/db'
import { getDb } from '../../lib/db'
import { resizeImageToBlob } from '../../lib/image'
import { createLure as createLureRemote, syncLures } from '../../lib/lures'
import type { CatchDraft, SyncEngine } from '../../lib/sync/sync-engine'
import { WebSyncEngine } from '../../lib/sync/sync-engine'
import { getActiveTrip, tripReferenceFor } from '../trips/trip-lifecycle'
import './capture-flow.css'
import { recentLureIds, recentSpecies } from './recents'
import { SPECIES } from './species'

type Step = 'idle' | 'species' | 'lure' | 'done'

export interface CaptureFlowProps {
  engine?: SyncEngine
  db?: WaterlogDb
  /** Injectable so component tests don't need a real Canvas/Image decoder. */
  resizeImage?: (file: File) => Promise<Blob>
}

/** Best-effort GPS fix — never blocks or fails capture (packet principle 5: capture is instant;
 * everything auto-capturable is auto-captured, but nothing waits on it). */
function bestEffortPosition(timeoutMs = 3000): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null)
      return
    }
    const timer = setTimeout(() => resolve(null), timeoutMs)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer)
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
      { timeout: timeoutMs },
    )
  })
}

/** F1: FAB -> camera -> photo -> species sheet -> lure sheet -> saved. Tapping a recent species
 * or lure advances immediately (no separate Save tap) — 2 taps after the photo on the common
 * path, well inside the packet's "<=4 taps after photo" budget. */
export function CaptureFlow({
  engine = new WebSyncEngine(),
  db = getDb(),
  resizeImage = resizeImageToBlob,
}: CaptureFlowProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('idle')
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null)
  const [selectedSpecies, setSelectedSpecies] = useState<string | null>(null)
  const [recentSpeciesSlugs, setRecentSpeciesSlugs] = useState<string[]>([])
  const [speciesQuery, setSpeciesQuery] = useState('')
  const [lures, setLures] = useState<Lure[]>([])
  const [recentLures, setRecentLures] = useState<Lure[]>([])
  const [lureQuery, setLureQuery] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)

  // Photography-forward (packet §09): show the just-taken photo while tagging it, not just
  // after. Object URLs are revoked as soon as they're replaced or the flow resets.
  useEffect(() => {
    // jsdom (component tests) doesn't implement createObjectURL — no preview there, which is
    // fine, the tests don't assert on it.
    if (!photoBlob || typeof URL.createObjectURL !== 'function') {
      setPhotoUrl(null)
      return
    }
    const url = URL.createObjectURL(photoBlob)
    setPhotoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [photoBlob])

  // Restarts on every toast change so the sync outcome, which lands after the first toast, is
  // on screen for its full dwell rather than inheriting the remainder of the optimistic one's.
  useEffect(() => {
    if (step !== 'done') return
    const timer = setTimeout(() => {
      setStep('idle')
      setPhotoBlob(null)
      setSelectedSpecies(null)
      setToast(null)
    }, 2500)
    return () => clearTimeout(timer)
  }, [step, toast])

  async function onPhotoSelected(file: File) {
    const resized = await resizeImage(file)
    setPhotoBlob(resized)
    setRecentSpeciesSlugs(await recentSpecies(db))
    setSpeciesQuery('')
    setStep('species')
  }

  async function onSpeciesChosen(slug: string) {
    setSelectedSpecies(slug)
    const [cached, recentIds] = await Promise.all([syncLures(db), recentLureIds(db)])
    setLures(cached)
    setRecentLures(cached.filter((l) => recentIds.includes(l.id)))
    setLureQuery('')
    setStep('lure')
  }

  async function saveCatch(lureId: string | null) {
    if (!selectedSpecies) return
    const caughtAt = Date.now()
    const [position, activeTrip] = await Promise.all([bestEffortPosition(), getActiveTrip(db)])

    let photoKey: string | null = null
    if (photoBlob) {
      try {
        photoKey = (await apiClient.uploadPhoto(photoBlob)).photo_key
      } catch {
        photoKey = null // offline or upload failed — the catch still saves without one
      }
    }

    const draft: CatchDraft = {
      trip_id: tripReferenceFor(activeTrip),
      lure_id: lureId,
      species: selectedSpecies,
      caught_at: caughtAt,
      lat: position?.lat ?? null,
      lng: position?.lng ?? null,
      photo_key: photoKey,
      length_mm: null,
      weight_g: null,
      depth_m: null,
      released: null,
      notes: null,
    }
    const localId = await engine.enqueueCatch(draft)
    // The catch is safe on the device the instant it's enqueued — say so now, and let the flush
    // below correct it. The toast reports whether the *catch* reached the server: enrichment
    // runs off the synced catch, so a failed photo upload doesn't make it "offline", and a
    // successful one doesn't make it synced.
    setToast('Logged.')
    setStep('done')
    void Promise.resolve(engine.flush())
      .catch(() => undefined)
      .then(async () => {
        const saved = await db.catches.get(localId)
        setToast(saved?.synced_at ? 'Logged. Enriching conditions…' : 'Logged offline — will sync.')
      })
  }

  async function onQuickAddLure(name: string) {
    try {
      const lure = await createLureRemote(db, name)
      await saveCatch(lure.id)
    } catch {
      await saveCatch(null) // offline: can't mint a server-known lure id right now
    }
  }

  // Recents are a shortcut, never a ceiling — the rest of the list stays scrollable below them
  // so there's always a way to reach any species/lure without typing a search query.
  const speciesSearchResults = speciesQuery
    ? SPECIES.filter((s) => s.label.toLowerCase().includes(speciesQuery.toLowerCase()))
    : null
  const recentSpeciesList = SPECIES.filter((s) => recentSpeciesSlugs.includes(s.slug))
  const restSpeciesList = SPECIES.filter((s) => !recentSpeciesSlugs.includes(s.slug))

  const lureSearchResults = lureQuery ? lures.filter((l) => l.name.toLowerCase().includes(lureQuery.toLowerCase())) : null
  const recentLureIdSet = new Set(recentLures.map((l) => l.id))
  const restLuresList = lures.filter((l) => !recentLureIdSet.has(l.id))

  const canQuickAdd =
    lureQuery.trim().length > 0 && !lures.some((l) => l.name.toLowerCase() === lureQuery.trim().toLowerCase())

  return (
    <div className="capture-flow">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Take or choose a catch photo"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void onPhotoSelected(file)
        }}
      />

      {step === 'idle' && (
        <button type="button" aria-label="Log a catch" className="fab" onClick={() => fileInputRef.current?.click()}>
          +
        </button>
      )}

      {step === 'species' && (
        <>
          <div className="sheet-scrim" />
          <div role="dialog" aria-label="Pick a species" className="sheet">
            <h2 className="sheet__title">What did you catch?</h2>
            {photoUrl && <img src={photoUrl} alt="Just-caught fish" className="sheet__photo" />}
            <input
              aria-label="Search species"
              className="sheet__search"
              placeholder="Search species…"
              value={speciesQuery}
              onChange={(e) => setSpeciesQuery(e.target.value)}
            />
            {speciesSearchResults ? (
              <ul className="sheet__list">
                {speciesSearchResults.map((s) => (
                  <li key={s.slug}>
                    <button type="button" className="sheet__item" onClick={() => void onSpeciesChosen(s.slug)}>
                      {s.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                {recentSpeciesList.length > 0 && (
                  <>
                    <p className="sheet__section-label">Recent</p>
                    <ul className="sheet__list">
                      {recentSpeciesList.map((s) => (
                        <li key={s.slug}>
                          <button type="button" className="sheet__item" onClick={() => void onSpeciesChosen(s.slug)}>
                            {s.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p className="sheet__section-label">All species</p>
                  </>
                )}
                <ul className="sheet__list">
                  {restSpeciesList.map((s) => (
                    <li key={s.slug}>
                      <button type="button" className="sheet__item" onClick={() => void onSpeciesChosen(s.slug)}>
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}

      {step === 'lure' && (
        <>
          <div className="sheet-scrim" />
          <div role="dialog" aria-label="Pick a lure" className="sheet">
            <h2 className="sheet__title">What were you throwing?</h2>
            {photoUrl && <img src={photoUrl} alt="Just-caught fish" className="sheet__photo" />}
            <button type="button" className="sheet__item sheet__item--skip" onClick={() => void saveCatch(null)}>
              No lure
            </button>
            <input
              aria-label="Search lures"
              className="sheet__search"
              placeholder="Search or add a lure…"
              value={lureQuery}
              onChange={(e) => setLureQuery(e.target.value)}
            />
            {lureSearchResults ? (
              <ul className="sheet__list">
                {lureSearchResults.map((l) => (
                  <li key={l.id}>
                    <button type="button" className="sheet__item" onClick={() => void saveCatch(l.id)}>
                      {l.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                {recentLures.length > 0 && (
                  <>
                    <p className="sheet__section-label">Recent</p>
                    <ul className="sheet__list">
                      {recentLures.map((l) => (
                        <li key={l.id}>
                          <button type="button" className="sheet__item" onClick={() => void saveCatch(l.id)}>
                            {l.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {restLuresList.length > 0 && <p className="sheet__section-label">All lures</p>}
                  </>
                )}
                <ul className="sheet__list">
                  {restLuresList.map((l) => (
                    <li key={l.id}>
                      <button type="button" className="sheet__item" onClick={() => void saveCatch(l.id)}>
                        {l.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {canQuickAdd && (
              <button type="button" className="sheet__quick-add" onClick={() => void onQuickAddLure(lureQuery.trim())}>
                + New lure &ldquo;{lureQuery.trim()}&rdquo;
              </button>
            )}
          </div>
        </>
      )}

      {step === 'done' && toast && (
        <div role="status" className="toast">
          <span className="toast__dot" aria-hidden="true" />
          {toast}
        </div>
      )}
    </div>
  )
}
