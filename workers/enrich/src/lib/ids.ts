import { ulid } from 'ulid'

/** Server-assigned primary key, per ADR-0004 (ULID, not UUID). */
export function newId(): string {
  return ulid()
}
