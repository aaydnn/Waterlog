import { NotImplementedError } from '../errors'

// Platform seam (ADR-0001): the sync engine has a web implementation and,
// later, a Capacitor-native implementation behind this same interface.
// Feature code imports the interface, never a concrete implementation.

/** Placeholder until packages/schema ships the Catch shape in T0.2. */
export type CatchRecord = Record<string, unknown>

export interface SyncResult {
  pushed: number
  failed: number
}

export interface SyncEngine {
  enqueue(record: CatchRecord): Promise<void>
  flush(): Promise<SyncResult>
}

/** Web stub — real offline queue + flush arrive in Epic 1. */
export class WebSyncEngine implements SyncEngine {
  enqueue(_record: CatchRecord): Promise<void> {
    return Promise.reject(new NotImplementedError('SyncEngine.enqueue'))
  }

  flush(): Promise<SyncResult> {
    return Promise.reject(new NotImplementedError('SyncEngine.flush'))
  }
}
