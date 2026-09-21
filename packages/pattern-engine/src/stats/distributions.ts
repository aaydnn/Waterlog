import { betaI, gammaP, gammaPInv, normalCdf } from './special';

/** P(X <= k), X ~ Poisson(mu). */
export function poissonCdf(k: number, mu: number): number {
  if (k < 0) return 0;
  if (mu <= 0) return 1;
  return 1 - gammaP(Math.floor(k) + 1, mu);
}

/** Exact one-sided upper confidence bound on a Poisson mean after observing k events. */
export function poissonUpper(k: number, level = 0.95): number {
  return gammaPInv(k + 1, level);
}

/** P(X <= k), X ~ Binomial(n, p). */
export function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  return betaI(1 - p, n - k, k + 1);
}

/** One-sided exact binomial tail. 'le' = P(X <= x), 'ge' = P(X >= x). */
export function binomTail(x: number, n: number, p: number, side: 'le' | 'ge'): number {
  return side === 'le' ? binomCdf(x, n, p) : 1 - binomCdf(x - 1, n, p);
}

/** Two-sided p from a z statistic. */
export function twoSidedP(z: number): number {
  return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
}

/** Benjamini–Hochberg q-values, returned in input order. */
export function benjaminiHochberg(p: ReadonlyArray<number>): number[] {
  const m = p.length;
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const q = new Array<number>(m);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    const [pv, i] = order[r]!;
    running = Math.min(running, (pv * m) / (r + 1));
    q[i] = Math.min(1, running);
  }
  return q;
}

/** Weighted quantile (weights = hours). Values sorted ascending internally. */
export function weightedQuantile(pairs: ReadonlyArray<readonly [number, number]>, q: number): number | null {
  const s = pairs.filter(([, w]) => w > 0).slice().sort((a, b) => a[0] - b[0]);
  if (s.length === 0) return null;
  const total = s.reduce((t, [, w]) => t + w, 0);
  let acc = 0;
  for (const [v, w] of s) {
    acc += w;
    if (acc >= q * total - 1e-12) return v;
  }
  return s[s.length - 1]![0];
}

export function quantile(values: ReadonlyArray<number>, q: number): number | null {
  return weightedQuantile(values.map((v) => [v, 1] as const), q);
}
