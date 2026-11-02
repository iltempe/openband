import { describe, expect, it } from 'vitest';
import { bandEnergyDb, correlation, lowpass, masking, rmsDb, width } from './dsp';

const SR = 44100;
const sine = (hz: number, n = SR, a = 0.5, phase = 0) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * hz * i) / SR + phase));
const add = (x: Float32Array, y: Float32Array) => x.map((v, i) => v + y[i]);

describe('measures', () => {
  it('rms of a sine', () => expect(rmsDb(sine(440, SR, 1))).toBeCloseTo(-3.01, 1));
  it('band energy sees the band', () => {
    const x = sine(1000);
    expect(bandEnergyDb(x, [800, 1200], SR)).toBeGreaterThan(bandEnergyDb(x, [5000, 6000], SR) + 40);
  });
  it('masking: same tone high, different tones low, silence zero', () => {
    expect(masking(sine(1000), sine(1000), [500, 2000], SR)).toBeGreaterThan(0.9);
    expect(masking(sine(800), sine(1800), [500, 2000], SR)).toBeLessThan(0.1);
    expect(masking(new Float32Array(SR), sine(1000), [500, 2000], SR)).toBe(0);
  });
  it('correlation and width', () => {
    const x = sine(440);
    expect(correlation(x, x)).toBeCloseTo(1);
    expect(correlation(x, x.map((v) => -v))).toBeCloseTo(-1);
    expect(width(x, x)).toBeCloseTo(0);
  });
  it('mono below: a wide top on a mono bass still counts as mono', () => {
    const bass = sine(60);
    const l = add(bass, sine(5000));
    const r = add(bass, sine(5000).map((v) => -v));
    expect(correlation(l, r)).toBeLessThan(0.7);
    expect(correlation(lowpass(l, 120, SR), lowpass(r, 120, SR))).toBeGreaterThan(0.98);
  });
});
