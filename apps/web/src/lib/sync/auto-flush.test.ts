import { describe, expect, it, vi } from 'vitest'
import { startAutoFlush } from './auto-flush'
import type { SyncEngine, SyncResult } from './sync-engine'

type Listener = () => void

/** A stand-in for window/document that lets a test fire the events itself. */
function fakeEventTarget() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: vi.fn((type: string, fn: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>()
      set.add(fn)
      listeners.set(type, set)
    }),
    removeEventListener: vi.fn((type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn)
    }),
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

function fakeEngine(flush: () => Promise<SyncResult>): SyncEngine {
  return {
    enqueueTrip: vi.fn(),
    enqueueCatch: vi.fn(),
    endTrip: vi.fn(),
    flush: vi.fn(flush),
  } as unknown as SyncEngine
}

const ok = () => Promise.resolve<SyncResult>({ pushed: 1, failed: 0 })

describe('startAutoFlush', () => {
  it('flushes once on start', async () => {
    const engine = fakeEngine(ok)
    startAutoFlush(engine, { window: fakeEventTarget(), document: fakeEventTarget() })

    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(1))
  })

  it('flushes again when the browser comes back online', async () => {
    const engine = fakeEngine(ok)
    const win = fakeEventTarget()
    startAutoFlush(engine, { window: win, document: fakeEventTarget() })
    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(1))

    win.fire('online')
    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(2))
  })

  it('flushes when the tab becomes visible, but not when it is hidden', async () => {
    const engine = fakeEngine(ok)
    const doc = fakeEventTarget()
    startAutoFlush(engine, { window: fakeEventTarget(), document: doc })
    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(1))

    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    expect(engine.flush).toHaveBeenCalledTimes(1)

    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(2))
  })

  it('skips the doomed request while the browser reports itself offline', async () => {
    const engine = fakeEngine(ok)
    const win = fakeEventTarget()
    const navigator = { onLine: false }
    startAutoFlush(engine, { window: win, document: fakeEventTarget(), navigator })

    expect(engine.flush).not.toHaveBeenCalled()

    navigator.onLine = true
    win.fire('online')
    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(1))
  })

  it('never runs two flushes at once, and runs exactly one more for triggers that arrived mid-flush', async () => {
    const pending: Array<() => void> = []
    const engine = fakeEngine(
      () => new Promise<SyncResult>((resolve) => pending.push(() => resolve({ pushed: 0, failed: 0 }))),
    )
    const win = fakeEventTarget()
    startAutoFlush(engine, { window: win, document: fakeEventTarget() })
    await vi.waitFor(() => expect(pending).toHaveLength(1))

    // Two triggers land while the first flush is still in the air.
    win.fire('online')
    win.fire('online')
    expect(engine.flush).toHaveBeenCalledTimes(1)

    pending[0]!()
    // They coalesce into a single follow-up run — not one per trigger.
    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(2))

    pending[1]!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(engine.flush).toHaveBeenCalledTimes(2)
  })

  it('keeps retrying after a flush rejects', async () => {
    const engine = fakeEngine(() => Promise.reject(new Error('boom')))
    const win = fakeEventTarget()
    startAutoFlush(engine, { window: win, document: fakeEventTarget() })
    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(1))

    win.fire('online')
    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(2))
  })

  it('unsubscribes its listeners and stops flushing when stopped', async () => {
    const engine = fakeEngine(ok)
    const win = fakeEventTarget()
    const doc = fakeEventTarget()
    const stop = startAutoFlush(engine, { window: win, document: doc })
    await vi.waitFor(() => expect(engine.flush).toHaveBeenCalledTimes(1))

    stop()
    expect(win.count('online')).toBe(0)
    expect(doc.count('visibilitychange')).toBe(0)

    win.fire('online')
    doc.fire('visibilitychange')
    expect(engine.flush).toHaveBeenCalledTimes(1)
  })

  it('does nothing but stay harmless with no window or document (SSR/tests)', () => {
    const engine = fakeEngine(ok)
    const stop = startAutoFlush(engine, { window: undefined, document: undefined })
    expect(() => stop()).not.toThrow()
  })
})
