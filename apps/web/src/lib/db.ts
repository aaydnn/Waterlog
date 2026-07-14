import Dexie from 'dexie'

/** Empty local database shell. Object stores (catch queue, trips cache, …)
 * land in Epic 1; Epic 0 only establishes the module seam. */
export class WaterlogDb extends Dexie {
  constructor() {
    super('waterlog')
  }
}

let instance: WaterlogDb | null = null

/** Lazy so importing this module never touches IndexedDB (tests, SSR). */
export function getDb(): WaterlogDb {
  instance ??= new WaterlogDb()
  return instance
}
