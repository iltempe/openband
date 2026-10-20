import { describe, expect, it } from 'vitest';
import { monitorLatency, punchComposite, recordingPlan, splitPasses } from './punch';

const SR = 44100;
const sine = (n: number, f: number, a: number) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / SR));

describe('punch-in (F25)', () => {
  it('a 2-bar punch replaces only that range, with 5 ms crossfades at the edges', () => {
    const bpm = 120;
    const bar = Math.round((4 * 60 * SR) / bpm);
    const orig = sine(bar * 4, 220, 0.5); // a 4-bar take
    const inS = bar;
    const outS = bar * 3; // bars 2–3
    const fade = Math.round(SR * 0.005);
    const rec = sine(outS - inS + 2 * fade, 330, 0.4);
    const y = punchComposite(orig, rec, inS, outS, fade);
    expect(y.length).toBe(orig.length);
    // Outside the punch and its fades: the original, untouched.
    for (const i of [0, 100, inS - fade - 1, outS + fade, orig.length - 1]) expect(y[i]).toBe(orig[i]);
    // Inside: only the new recording.
    for (const i of [inS, inS + 5000, outS - 1]) expect(y[i]).toBeCloseTo(rec[i - (inS - fade)], 6);
    // The fades are 5 ms and smooth (no jump bigger than either signal's own steps).
    const maxStep = (x: Float32Array, a: number, b: number) => {
      let m = 0;
      for (let i = a + 1; i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
      return m;
    };
    // While fading both play: a jump would exceed the sum of the two signals' own steps.
    const own = maxStep(orig, 0, 2000) + maxStep(rec, 0, 2000);
    expect(maxStep(y, inS - fade - 2, inS + 2)).toBeLessThanOrEqual(own);
    expect(maxStep(y, outS - 2, outS + fade + 2)).toBeLessThanOrEqual(own);
    // A hard cut (no fade) would jump much more at the punch point.
    const hard = punchComposite(orig, rec.subarray(fade), inS + 0, outS, 0);
    expect(Math.abs(hard[inS] - hard[inS - 1])).toBeGreaterThan(maxStep(y, inS - fade - 2, inS + 2));
    expect(fade).toBe(221);
  });

  it('pre-roll plays bars before the punch and keeps only the punch range', () => {
    const p = recordingPlan({ startBeat: 0, bpm: 120, punch: { enabled: true, inBeat: 16, outBeat: 24, preRollBars: 2 } });
    expect(p).toMatchObject({ transportFrom: 8, countInBeats: 0, keepFrom: 4, keepTo: 8, regionStart: 16, punched: true });
    // At the song start there is less room for a pre-roll.
    expect(recordingPlan({ startBeat: 0, bpm: 120, punch: { enabled: true, inBeat: 4, outBeat: 8, preRollBars: 2 } })).toMatchObject({ transportFrom: 0, keepFrom: 2 });
    expect(recordingPlan({ startBeat: 8, bpm: 120, bars: 2 })).toMatchObject({ transportFrom: 8, countInBeats: 4, keepFrom: 0, keepTo: 4, punched: false });
  });

  it('loop recording: one take per pass', () => {
    const pass = 1000;
    expect(splitPasses(new Float32Array(3600), pass).length).toBe(4); // 3 full + 0.6 of a pass
    expect(splitPasses(new Float32Array(3400), pass).length).toBe(3);
    expect(splitPasses(new Float32Array(3600), pass)[3].length).toBe(pass);
    expect(monitorLatency(0.005, 0.02)).toEqual({ ms: 25, noticeable: true });
    expect(monitorLatency(0.003, 0.005).noticeable).toBe(false);
  });
});
