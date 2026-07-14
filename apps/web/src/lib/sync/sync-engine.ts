import type { Catch } from '@waterlog/schema'
import { NotImplementedError } from '../errors'

// Platform seam (ADR-0001): the sync engine has a web implementation and,
// later, a Capacitor-native implementation behind this same interface.
// Feature code imports the interface, never a concrete implementation.

export interface SyncResult {
  pushed: number
  failed: number
}

export interface SyncEngine {
  enqueue(record: Catch): Promise<void>
  flush(): Promise<SyncResult>
}

/** Web stub — real offline queue + flush arrive in Epic 1. */
export class WebSyncEngine implements SyncEngine {
  enqueue(_record: Catch): Promise<void> {
    return Promise.reject(new NotImplementedError('SyncEngine.enqueue'))
  }

  flush(): Promise<SyncResult> {
    return Promise.reject(new NotImplementedError('SyncEngine.flush'))
  }
}
