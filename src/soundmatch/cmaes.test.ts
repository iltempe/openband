// The search behind sound-alike (SPEC v0.6 G5): CMA-ES finds a known point, and the note features tell
// sounds apart the way the ear does.
import { describe, expect, it } from 'vitest';
import { Cma, eigenSym, minimise } from './cmaes';
import { distance, noteFeatures, similarity } from './features';

describe('CMA-ES', () => {
  it('eigen-decomposition of a symmetric matrix', () => {
    const { values, vectors } = eigenSym([[4, 1], [1, 3]]);
    const C = [0, 1].map((i) => [0, 1].map((j) => vectors[i][0] * values[0] * vectors[j][0] + vectors[i][1] * values[1] * vectors[j][1]));
    expect(C[0][0]).toBeCloseTo(4, 6);
    expect(C[0][1]).toBeCloseTo(1, 6);
  });

  it('finds the minimum of a shifted, badly scaled quadratic in the box within its budget', async () => {
    const target = [0.2, 0.8, 0.55, 0.35, 0.9, 0.1, 0.6, 0.45];
    const f = (x: number[]) => x.reduce((s, v, i) => s + (i + 1) * (v - target[i]) ** 2, 0);
    const r = await minimise(async (xs) => xs.map(f), Array(8).fill(0.5), 300, { seed: 3 });
    expect(r.evals).toBeLessThanOrEqual(300);
    // The cost is near zero; the coordinates that matter most are found closely.
    expect(r.f).toBeLessThan(0.01);
    for (const i of [4, 5, 6, 7]) expect(Math.abs(r.x[i] - target[i])).toBeLessThan(0.05);
    expect(new Cma([0.5, 0.5]).lambda).toBe(6);
  });
});

describe('note features and distance', () => {
  const SR = 22050;
  const note = (o: { hz?: number; attack?: number; decay?: number; sustain?: number; bright?: number; seconds?: number }) => {
    const n = Math.round((o.seconds ?? 1) * SR);
    const a = o.attack ?? 0.005;
    const d = o.decay ?? 0.2;
    const s = o.sustain ?? 0.5;
    return Float32Array.from({ length: n }, (_, i) => {
      const t = i / SR;
      const env = t < a ? t / a : s + (1 - s) * Math.exp(-(t - a) / d);
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * (o.hz ?? 220) * h * t) * (o.bright ?? 0.5) ** (h - 1);
      return 0.3 * env * v;
    });
  };
  it('the same note is identical; a slower attack, a duller tone and another envelope are further', () => {
    const ref = noteFeatures(note({}), SR);
    expect(distance(ref, noteFeatures(note({}), SR))).toBeLessThan(1e-6);
    expect(similarity(0)).toBe(1);
    expect(ref.attack).toBeLessThan(0.02);
    const slow = noteFeatures(note({ attack: 0.3 }), SR);
    expect(slow.attack).toBeGreaterThan(0.15);
    const dull = noteFeatures(note({ bright: 0.15 }), SR);
    const plucky = noteFeatures(note({ sustain: 0, decay: 0.08 }), SR);
    expect(plucky.sustain).toBeLessThan(0.1);
    const near = noteFeatures(note({ bright: 0.45 }), SR);
    for (const far of [slow, dull, plucky]) expect(distance(ref, far)).toBeGreaterThan(distance(ref, near) * 2);
    // Louder is not different.
    expect(distance(ref, noteFeatures(note({}).map((v) => v * 0.3), SR))).toBeLessThan(0.05);
  });
});
