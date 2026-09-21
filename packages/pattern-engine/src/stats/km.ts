/** Kaplan–Meier over right-censored durations (time to first fish; skunks are censored). */
export interface KmPoint { t: number; s: number; atRisk: number }

export function kaplanMeier(obs: ReadonlyArray<{ t: number; event: boolean }>): KmPoint[] {
  const sorted = obs.slice().sort((a, b) => a.t - b.t || Number(b.event) - Number(a.event));
  let atRisk = sorted.length;
  let s = 1;
  const out: KmPoint[] = [];
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i]!.t;
    let d = 0;
    let c = 0;
    while (i < sorted.length && sorted[i]!.t === t) {
      if (sorted[i]!.event) d++;
      else c++;
      i++;
    }
    if (d > 0) {
      s *= 1 - d / atRisk;
      out.push({ t, s, atRisk });
    }
    atRisk -= d + c;
  }
  return out;
}

export function survivalAt(curve: ReadonlyArray<KmPoint>, t: number): number {
  let s = 1;
  for (const p of curve) {
    if (p.t > t) break;
    s = p.s;
  }
  return s;
}

export function kmMedian(curve: ReadonlyArray<KmPoint>): number | null {
  for (const p of curve) if (p.s <= 0.5) return p.t;
  return null;
}
