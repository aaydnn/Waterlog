import { ulid } from 'ulid'

/** Server-assigned primary key for any table created after ADR-0004 (ULID, not UUID). */
export function newId(): string {
  return ulid()
}
