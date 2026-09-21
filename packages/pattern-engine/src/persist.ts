import type { EngineResult, Finding } from './types';

/** Compact shape for D1 JSON columns: receipts keep the 10 most supporting and 10 most contrary trips. */
export function toPersisted(result: EngineResult, receiptTrips = 10): EngineResult {
  const trim = (f: Finding): Finding => {
    const sign = f.direction === 'positive' ? 1 : -1;
    const ranked = f.stats.trips.slice().sort((a, b) => sign * ((b.catches - b.expected) - (a.catches - a.expected)) || (a.tripId < b.tripId ? -1 : 1));
    const keep = new Set([...ranked.slice(0, receiptTrips), ...ranked.slice(-receiptTrips)].map((t) => t.tripId));
    return { ...f, stats: { ...f.stats, trips: f.stats.trips.filter((t) => keep.has(t.tripId)) } };
  };
  return { ...result, families: result.families.map((fam) => ({ ...fam, findings: fam.findings.map(trim) })) };
}
