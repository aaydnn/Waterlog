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

  useEffect(() => {
    if (step !== 'done') return
    const timer = setTimeout(() => {
      setStep('idle')
      setPhotoBlob(null)
      setSelectedSpecies(null)
      setToast(null)
    }, 2500)
    return () => clearTimeout(timer)
  }, [step])

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
    await engine.enqueueCatch(draft)
    setToast(photoKey ? 'Logged. Enriching conditions…' : 'Logged offline — will sync.')
    setStep('done')
    void engine.flush()
  }

  async function onQuickAddLure(name: string) {
    try {
      const lure = await createLureRemote(db, name)
      await saveCatch(lure.id)
    } catch {
      await saveCatch(null) // offline: can't mint a server-known lure id right now
    }
  }

  // Before this device has any catch history, "recents" is empty — fall back to the full list
  // rather than showing nothing (first-ever capture is exactly when this matters most).
  const recentSpeciesList = SPECIES.filter((s) => recentSpeciesSlugs.includes(s.slug))
  const visibleSpecies = speciesQuery
    ? SPECIES.filter((s) => s.label.toLowerCase().includes(speciesQuery.toLowerCase()))
    : recentSpeciesList.length > 0
      ? recentSpeciesList
      : SPECIES

  const visibleLures = lureQuery
    ? lures.filter((l) => l.name.toLowerCase().includes(lureQuery.toLowerCase()))
    : recentLures.length > 0
      ? recentLures
      : lures

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
        <div role="dialog" aria-label="Pick a species">
          <input
            aria-label="Search species"
            value={speciesQuery}
            onChange={(e) => setSpeciesQuery(e.target.value)}
          />
          <ul>
            {visibleSpecies.map((s) => (
              <li key={s.slug}>
                <button type="button" onClick={() => void onSpeciesChosen(s.slug)}>
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step === 'lure' && (
        <div role="dialog" aria-label="Pick a lure">
          <button type="button" onClick={() => void saveCatch(null)}>
            No lure
          </button>
          <input aria-label="Search lures" value={lureQuery} onChange={(e) => setLureQuery(e.target.value)} />
          <ul>
            {visibleLures.map((l) => (
              <li key={l.id}>
                <button type="button" onClick={() => void saveCatch(l.id)}>
                  {l.name}
                </button>
              </li>
            ))}
          </ul>
          {canQuickAdd && (
            <button type="button" onClick={() => void onQuickAddLure(lureQuery.trim())}>
              + New lure &ldquo;{lureQuery.trim()}&rdquo;
            </button>
          )}
        </div>
      )}

      {step === 'done' && toast && <div role="status">{toast}</div>}
    </div>
  )
}
