/** Result of an idempotent `INSERT ... ON CONFLICT DO NOTHING` upsert: the canonical row, plus
 * whether this call actually inserted it (vs. a replay landing on an existing row). Callers use
 * `isNew` to fire once-only side effects (queue enqueues) that must never happen on a replay. */
export interface UpsertResult<T> {
  row: T
  isNew: boolean
}
