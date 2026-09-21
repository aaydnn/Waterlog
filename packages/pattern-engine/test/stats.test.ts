import { describe, expect, it } from 'vitest';
import { mantelHaenszel, shrink } from '../src/analyze';
import { benjaminiHochberg, binomCdf, binomTail, poissonCdf, poissonUpper, quantile, twoSidedP, weightedQuantile } from '../src/stats/distributions';
import { kaplanMeier, kmMedian, survivalAt } from '../src/stats/km';
import { betaI, gammaP, gammaPInv, lgamma, normalCdf, normalQuantile } from '../src/stats/special';

describe('special functions', () => {
  it('lgamma matches factorials', () => {
    expect(lgamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(lgamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
    expect(lgamma(0.25)).toBeCloseTo(1.2880225246980774, 9);
  });
  it('incomplete gamma both branches and inverse', () => {
    expect(gammaP(1, 1)).toBeCloseTo(1 - Math.exp(-1), 10);
    expect(gammaP(2, 10)).toBeCloseTo(1 - 11 * Math.exp(-10), 10);
    expect(gammaP(3, 0)).toBe(0);
    expect(gammaPInv(3, gammaP(3, 2.5))).toBeCloseTo(2.5, 6);
    expect(gammaPInv(3, 0)).toBe(0);
  });
  it('incomplete beta', () => {
    expect(betaI(0.3, 1, 1)).toBeCloseTo(0.3, 10);
    expect(betaI(0.9, 2, 3)).toBeCloseTo(0.9963, 4);
    expect(betaI(0, 2, 3)).toBe(0);
    expect(betaI(1, 2, 3)).toBe(1);
  });
  it('normal cdf/quantile', () => {
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232, 5);
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
  });
});

describe('distributions', () => {
  it('poisson', () => {
    expect(poissonUpper(0)).toBeCloseTo(2.995732, 5);
    expect(poissonUpper(5)).toBeCloseTo(10.513, 2);
    expect(poissonCdf(2, 1)).toBeCloseTo(Math.exp(-1) * 2.5, 10);
    expect(poissonCdf(-1, 1)).toBe(0);
    expect(poissonCdf(3, 0)).toBe(1);
  });
  it('binomial', () => {
    expect(binomCdf(3, 10, 0.5)).toBeCloseTo(176 / 1024, 10);
    expect(binomTail(7, 10, 0.5, 'ge')).toBeCloseTo(176 / 1024, 10);
    expect(binomCdf(-1, 10, 0.5)).toBe(0);
    expect(binomCdf(10, 10, 0.5)).toBe(1);
    expect(binomCdf(2, 10, 0)).toBe(1);
    expect(binomCdf(2, 10, 1)).toBe(0);
  });
  it('BH q-values (R p.adjust reference)', () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.2]);
    expect(q.map((x) => +x.toFixed(4))).toEqual([0.04, 0.0533, 0.0533, 0.2]);
    expect(benjaminiHochberg([])).toEqual([]);
  });
  it('quantiles and two-sided p', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(weightedQuantile([[1, 1], [10, 9]], 0.5)).toBe(10);
    expect(weightedQuantile([], 0.5)).toBeNull();
    expect(twoSidedP(1.959964)).toBeCloseTo(0.05, 5);
  });
});

describe('Kaplan–Meier', () => {
  it('handles censoring and ties', () => {
    const c = kaplanMeier([
      { t: 10, event: true },
      { t: 20, event: false },
      { t: 30, event: true },
      { t: 30, event: true },
      { t: 40, event: false },
    ]);
    expect(c[0]!.s).toBeCloseTo(0.8);
    expect(c[1]!.s).toBeCloseTo(0.8 * (1 - 2 / 3));
    expect(kmMedian(c)).toBe(30);
    expect(survivalAt(c, 25)).toBeCloseTo(0.8);
    expect(kmMedian(kaplanMeier([{ t: 5, event: false }]))).toBeNull();
  });
});

describe('Mantel–Haenszel', () => {
  it('equal rates → RR ≈ 1, stratification removes a pure stratum effect', () => {
    const rows = [
      { a: 10, t1: 10, n: 40, T: 40 * 1 },
      { a: 30, t1: 10, n: 120, T: 40 },
    ];
    // bucket rate == complement rate within each stratum
    const res = mantelHaenszel(rows.map((r) => ({ ...r, T: r.T })), 1, 3)!;
    expect(Math.exp(res.logRR)).toBeCloseTo(1, 6);
    expect(res.pValue).toBeGreaterThan(0.5);
  });
  it('returns null when bucket has no comparable complement hours', () => {
    expect(mantelHaenszel([{ a: 3, t1: 5, n: 3, T: 5 }], 1, 3)).toBeNull();
  });
  it('continuity correction for zero catches; exact path for tiny counts', () => {
    const res = mantelHaenszel([{ a: 0, t1: 4, n: 3, T: 12 }], 1, 3)!;
    expect(res.logRR).toBeLessThan(0);
    expect(res.pValue).toBeGreaterThan(0);
    const none = mantelHaenszel([{ a: 0, t1: 4, n: 0, T: 12 }], 1, 3)!;
    expect(none.pValue).toBe(1);
  });
  it('shrinkage pulls noisy estimates toward 1', () => {
    const s = shrink(Math.log(4), 1, Math.log(2) / 1.96);
    expect(Math.exp(s.mean)).toBeLessThan(1.5);
    expect(shrink(Math.log(4), 0.001, 0.35).mean).toBeCloseTo(Math.log(4), 1);
  });
});
