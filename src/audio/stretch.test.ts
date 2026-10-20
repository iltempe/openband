import { describe, expect, it } from 'vitest';
import { bpmFromName, detectTempo, processChannel, stretchFactor } from './stretch';

const SR = 44100;
const sine = (sec: number, f: number, a = 0.5) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / SR));
/** A drum-like loop: a short decaying burst on every beat. */
function clicks(bpm: number, beats: number) {
  const x = new Float32Array(Math.round(((beats * 60) / bpm) * SR));
  let seed = 3;
  for (let b = 0; b < beats; b++) {
    const at = Math.round(((b * 60) / bpm) * SR);
    for (let i = 0; i < SR * 0.04 && at + i < x.length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      x[at + i] = (seed / 2147483648 - 0.5) * 1.6 * Math.exp((-i / SR) * 90);
    }
  }
  return x;
}
const maxStep = (x: Float32Array) => {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
/** Frequency from upward zero crossings (middle part, away from the edges). */
function freqOf(x: Float32Array) {
  const from = Math.floor(x.length * 0.2);
  const to = Math.floor(x.length * 0.8);
  const ups: number[] = [];
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) ups.push(i - x[i] / (x[i] - x[i - 1]));
  return ((ups.length - 1) * SR) / (ups[ups.length - 1] - ups[0]);
}
/** Onsets: where the 2 ms envelope first crosses a threshold after a quiet stretch. */
function onsets(x: Float32Array) {
  const hop = Math.round(SR * 0.002);
  const out: number[] = [];
  let quiet = true;
  for (let i = 0; i + hop <= x.length; i += hop) {
    let e = 0;
    for (let k = 0; k < hop; k++) e = Math.max(e, Math.abs(x[i + k]));
    if (quiet && e > 0.2) {
      out.push(i / SR);
      quiet = false;
    } else if (e < 0.02) quiet = true;
  }
  return out;
}

describe('time-stretch (WSOLA)', () => {
  for (const factor of [0.8, 1.25]) {
    it(`${factor}×: the right length, no click at the edges or inside`, () => {
      const x = sine(2, 440);
      const y = processChannel(x, factor, 0, SR);
      expect(Math.abs(y.length - x.length * factor)).toBeLessThanOrEqual(1);
      // No step larger than the sine itself has (a click would be a jump).
      expect(maxStep(y)).toBeLessThan(maxStep(x) * 1.3);
      expect(Math.abs(y[0])).toBeLessThan(1e-3);
      expect(Math.abs(y[y.length - 1])).toBeLessThan(1e-3);
      // Same pitch.
      expect(freqOf(y)).toBeCloseTo(440, -0.5);
    });
  }

  it('follow_tempo: a 100 BPM loop played at 120 BPM keeps every onset on the grid (spec ±10 ms; within 5)', () => {
    const x = clicks(100, 8);
    const factor = stretchFactor({ stretch: { mode: 'follow_tempo', originalBpm: 100 } }, 120);
    expect(factor).toBeCloseTo(100 / 120, 6);
    const y = processChannel(x, factor, 0, SR);
    const on = onsets(y);
    expect(on).toHaveLength(8);
    on.forEach((t, k) => expect(Math.abs(t - k * 0.5), `onset ${k} at ${t.toFixed(4)} s`).toBeLessThanOrEqual(0.005));
  });
});

describe('pitch shift (phase vocoder + resampling)', () => {
  for (const semis of [3, -5]) {
    it(`${semis > 0 ? '+' : ''}${semis} semitones keeps the length and moves the pitch`, () => {
      const x = sine(2, 440);
      const y = processChannel(x, 1, semis, SR);
      expect(y.length).toBe(x.length);
      const want = 440 * Math.pow(2, semis / 12);
      expect(Math.abs(freqOf(y) - want) / want).toBeLessThan(0.01);
      expect(maxStep(y)).toBeLessThan(maxStep(sine(1, want)) * 1.5);
    });
  }

  it('stretch and pitch together', () => {
    const y = processChannel(sine(2, 330), 1.25, 2, SR);
    expect(Math.abs(y.length - 2 * SR * 1.25)).toBeLessThanOrEqual(1);
    expect(Math.abs(freqOf(y) - 330 * Math.pow(2, 2 / 12)) / 370).toBeLessThan(0.01);
  });
});

describe('tempo detection', () => {
  it('from the file name', () => {
    expect(bpmFromName('drumloop_92bpm.wav')).toBe(92);
    expect(bpmFromName('Funk 120 BPM.wav')).toBe(120);
    expect(bpmFromName('BPM-174 jungle.wav')).toBe(174);
    expect(bpmFromName('take 3.wav')).toBeNull();
  });

  it('from the audio of a loop', () => {
    for (const bpm of [92, 128, 75]) {
      const r = detectTempo(clicks(bpm, 8), SR);
      expect(r.source).toBe('audio');
      expect(Math.abs(r.bpm - bpm), `${bpm} → ${r.bpm}`).toBeLessThan(1);
    }
    expect(detectTempo(sine(1, 220), SR, 'pad_96bpm.wav')).toMatchObject({ bpm: 96, source: 'name' });
  });

  it('stretch factors', () => {
    expect(stretchFactor({}, 120)).toBe(1);
    expect(stretchFactor({ stretch: { mode: 'off', ratio: 2 } }, 120)).toBe(1);
    expect(stretchFactor({ stretch: { mode: 'fixed', ratio: 1.25 } }, 120)).toBe(1.25);
    expect(stretchFactor({ stretch: { mode: 'follow_tempo', originalBpm: 90 } }, 120)).toBe(0.75);
  });
});
