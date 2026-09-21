import { describe, expect, it } from 'vitest';
import { findingKey, parseFindingKey } from '../src/family';

describe('finding keys', () => {
  it('round-trips a plain single-dimension finding', () => {
    const key = findingKey('all', 'all', 'pressure_trend', 'falling');
    expect(key).toBe('all::all::pressure_trend::falling');
    expect(parseFindingKey(key)).toEqual({
      scopeId: 'all',
      outcome: 'all',
      dimension: 'pressure_trend',
      bucket: 'falling',
    });
  });

  it('round-trips a per-water species combo, whose parts carry their own separators', () => {
    // A combo dimension joins with '+' and its bucket with '|', neither of which may be confused
    // with the key separator — this is the shape the writer has to locate in D1.
    const key = findingKey('wtr_norris', 'species:smallmouth', 'sky+time_block', 'overcast|dawn');
    expect(parseFindingKey(key)).toEqual({
      scopeId: 'wtr_norris',
      outcome: 'species:smallmouth',
      dimension: 'sky+time_block',
      bucket: 'overcast|dawn',
    });
  });

  it('keeps a bucket that contains the separator rather than truncating it', () => {
    const parsed = parseFindingKey('all::all::notes::a::b');
    expect(parsed.dimension).toBe('notes');
    expect(parsed.bucket).toBe('a::b');
  });

  it('degrades to empty parts on a malformed key instead of throwing', () => {
    // A key this shape means a corrupt row, and losing one finding's history beats failing the
    // run for every other finding the angler has.
    expect(parseFindingKey('')).toEqual({ scopeId: '', outcome: 'all', dimension: '', bucket: '' });
    expect(parseFindingKey('all')).toEqual({ scopeId: 'all', outcome: 'all', dimension: '', bucket: '' });
    expect(parseFindingKey('all::all')).toEqual({
      scopeId: 'all',
      outcome: 'all',
      dimension: '',
      bucket: '',
    });
  });
});
