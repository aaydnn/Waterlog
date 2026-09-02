// @vitest-environment jsdom
import type { Lure } from '@waterlog/schema'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WaterlogDb } from '../../lib/db'
import type { CatchDraft, SyncEngine, SyncResult, TripDraft } from '../../lib/sync/sync-engine'
import { CaptureFlow } from './capture-flow'

let dbCounter = 0
function freshDb(): WaterlogDb {
  dbCounter += 1
  return new WaterlogDb(`test-capture-flow-${dbCounter}`)
}

function fakeEngine(): SyncEngine {
  return {
    enqueueTrip: vi.fn<(draft: TripDraft) => Promise<string>>().mockResolvedValue('trip_local_1'),
    enqueueCatch: vi.fn<(draft: CatchDraft) => Promise<string>>().mockResolvedValue('catch_local_1'),
    endTrip: vi.fn<(localId: string, endedAt: number) => Promise<void>>(),
    flush: vi.fn<() => Promise<SyncResult>>().mockResolvedValue({ pushed: 0, failed: 0 }),
  }
}

const fakePhoto = new File(['fake-bytes'], 'catch.jpg', { type: 'image/jpeg' })

function mockFetch(lures: Partial<Lure>[] = [], uploadOk = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/lures')) {
        return { ok: true, status: 200, json: async () => ({ lures }) }
      }
      if (url.includes('/api/photos')) {
        return uploadOk
          ? { ok: true, status: 201, json: async () => ({ photo_key: 'photos/u1/photo.jpg' }) }
          : { ok: false, status: 500, json: async () => ({ error: 'upload failed' }) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('CaptureFlow (F1: ten-second capture)', () => {
  it('logs a catch in exactly 2 taps after the photo — species then a recent lure', async () => {
    mockFetch([{ id: 'lure_1', name: 'War Eagle Spinnerbait' }])
    const engine = fakeEngine()
    const user = userEvent.setup()
    render(<CaptureFlow engine={engine} db={freshDb()} resizeImage={async () => new Blob(["resized"])} />)

    // Photo capture triggers the flow (not counted as a "tap after photo" per the spec's wording).
    const input = screen.getByLabelText('Take or choose a catch photo')
    await user.upload(input, fakePhoto)

    // Tap 1: species (no search needed — it's already a recent).
    await screen.findByRole('dialog', { name: 'Pick a species' })
    await user.click(screen.getByRole('button', { name: 'Largemouth Bass' }))

    // Tap 2: lure.
    await screen.findByRole('dialog', { name: 'Pick a lure' })
    await user.click(await screen.findByRole('button', { name: 'War Eagle Spinnerbait' }))

    await waitFor(() => expect(engine.enqueueCatch).toHaveBeenCalledTimes(1))
    const draft = (engine.enqueueCatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CatchDraft
    expect(draft.species).toBe('largemouth_bass')
    expect(draft.lure_id).toBe('lure_1')
    expect(draft.photo_key).toBe('photos/u1/photo.jpg')

    expect(await screen.findByRole('status')).toHaveTextContent('Logged. Enriching conditions…')
  })

  it('logs a catch in 2 taps with no lure selected ("No lure" shortcut)', async () => {
    mockFetch([])
    const engine = fakeEngine()
    const user = userEvent.setup()
    render(<CaptureFlow engine={engine} db={freshDb()} resizeImage={async () => new Blob(["resized"])} />)

    await user.upload(screen.getByLabelText('Take or choose a catch photo'), fakePhoto)
    await user.click(await screen.findByRole('button', { name: 'Bluegill' }))
    await user.click(await screen.findByRole('button', { name: 'No lure' }))

    await waitFor(() => expect(engine.enqueueCatch).toHaveBeenCalledTimes(1))
    const draft = (engine.enqueueCatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CatchDraft
    expect(draft.lure_id).toBeNull()
  })

  it('still logs the catch — without a photo_key — when the photo upload fails offline', async () => {
    mockFetch([], false)
    const engine = fakeEngine()
    const user = userEvent.setup()
    render(<CaptureFlow engine={engine} db={freshDb()} resizeImage={async () => new Blob(["resized"])} />)

    await user.upload(screen.getByLabelText('Take or choose a catch photo'), fakePhoto)
    await user.click(await screen.findByRole('button', { name: 'Bluegill' }))
    await user.click(await screen.findByRole('button', { name: 'No lure' }))

    await waitFor(() => expect(engine.enqueueCatch).toHaveBeenCalledTimes(1))
    const draft = (engine.enqueueCatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CatchDraft
    expect(draft.photo_key).toBeNull()
    expect(await screen.findByRole('status')).toHaveTextContent('Logged offline — will sync.')
  })

  it('searching for a species not in the recents shelf still finds and selects it', async () => {
    mockFetch([])
    const engine = fakeEngine()
    const user = userEvent.setup()
    render(<CaptureFlow engine={engine} db={freshDb()} resizeImage={async () => new Blob(["resized"])} />)

    await user.upload(screen.getByLabelText('Take or choose a catch photo'), fakePhoto)
    await user.type(await screen.findByLabelText('Search species'), 'walleye')
    await user.click(screen.getByRole('button', { name: 'Walleye' }))
    await user.click(await screen.findByRole('button', { name: 'No lure' }))

    await waitFor(() => expect(engine.enqueueCatch).toHaveBeenCalledTimes(1))
    const draft = (engine.enqueueCatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CatchDraft
    expect(draft.species).toBe('walleye')
  })
})
