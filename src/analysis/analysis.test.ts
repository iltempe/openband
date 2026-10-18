import { describe, expect, it } from 'vitest';
import { fft, powerSpectrum } from './fft';
import { loudness, truePeak } from './loudness';
import { averageSpectrum, bandPowers } from './spectrum';
import { stereo } from './stereo';
import { bandFrames, masking } from './masking';
import { keyFromProfile, profileFromNotes, scalePitchClasses } from './key';
import { analyzeAudio } from './analyze';

const FS = 48000;
const sine = (freq: number, amp: number, seconds: number, fs = FS, phase = 0) =>
  Float32Array.from({ length: Math.round(seconds * fs) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / fs + phase));

/** Pink-ish noise (Paul Kellet's filter) from a seeded generator. */
function pink(seconds: number, amp: number, fs = FS) {
  let s = 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return Float32Array.from({ length: Math.round(seconds * fs) }, () => {
    const w = rnd();
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return out * 0.11 * amp;
  });
}

describe('FFT', () => {
  it('puts a sine in the right bin', () => {
    const n = 1024;
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 37 * i) / n));
    const im = new Float64Array(n);
    fft(re, im);
    const mags = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
    expect(mags.indexOf(Math.max(...mags))).toBe(37);
  });
  it('power spectrum sums to the mean square', () => {
    const x = sine(1000, 0.5, 0.2);
    const p = powerSpectrum(x, 0, 4096);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(0.125, 2);
  });
});

describe('loudness (BS.1770)', () => {
  it('1 kHz sine at −20 dBFS reads ≈ −23 LUFS', () => {
    const L = loudness([sine(1000, 0.1, 5)], FS);
    expect(L.integrated).toBeGreaterThan(-23.3);
    expect(L.integrated).toBeLessThan(-22.7);
    expect(L.samplePeak).toBeCloseTo(-20, 1);
  });
  it('works at 44.1 kHz too', () => {
    const L = loudness([sine(1000, 0.1, 5, 44100)], 44100);
    expect(Math.abs(L.integrated + 23)).toBeLessThan(0.3);
  });
  it('handles silence', () => {
    const L = loudness([new Float32Array(FS * 2), new Float32Array(FS * 2)], FS);
    expect(L.integrated).toBe(-Infinity);
    expect(L.truePeak).toBe(-Infinity);
    expect(L.clipped).toBe(0);
  });
  it('steady pink noise has a stable short-term loudness and no range', () => {
    const L = loudness([pink(8, 1)], FS);
    expect(Number.isFinite(L.integrated)).toBe(true);
    expect(Math.abs(L.shortTermMax - L.integrated)).toBeLessThan(1);
    expect(L.lra).toBeLessThan(1);
  });
  it('finds inter-sample peaks', () => {
    // fs/4 sine shifted by 45°: samples hit ±0.707, the waveform reaches ±1.
    const x = sine(FS / 4, 1, 0.1, FS, Math.PI / 4);
    expect(Math.max(...Array.from(x, Math.abs))).toBeCloseTo(0.707, 2);
    expect(truePeak(x)).toBeGreaterThan(0.97);
  });
});

describe('spectrum and stereo', () => {
  it('puts energy in the right band', () => {
    const b = bandPowers(averageSpectrum(sine(100, 0.5, 1, 44100)), 44100);
    expect(Object.entries(b).sort((x, y) => y[1] - x[1])[0][0]).toBe('bass');
  });
  it('measures correlation and mono loss', () => {
    const l = sine(440, 0.5, 1);
    expect(stereo(l, l, FS)).toMatchObject({ correlation: 1, width: 0, monoLossDb: 0 });
    const inv = l.map((x) => -x);
    expect(stereo(l, inv, FS).correlation).toBeCloseTo(-1, 2);
  });
});

describe('masking', () => {
  it('two 80 Hz sines mask each other, 80 Hz vs 5 kHz do not', () => {
    const a = bandFrames(sine(80, 0.5, 2, 44100), 44100);
    const b = bandFrames(sine(80, 0.4, 2, 44100), 44100);
    const c = bandFrames(sine(5000, 0.5, 2, 44100), 44100);
    const high = masking([{ name: 'Bass', frames: a }, { name: 'Kick', frames: b }]);
    expect(high[0]).toMatchObject({ band: 'bass' });
    expect(high[0].score).toBeGreaterThan(0.7); // 2·min/sum = 0.78 for amplitudes 0.5 and 0.4
    const low = masking([{ name: 'Bass', frames: a }, { name: 'Hat', frames: c }]);
    expect(low.find((p) => p.band === 'bass')).toBeUndefined();
    expect(Math.max(0, ...low.map((p) => p.score))).toBeLessThan(0.2);
  });
});

describe('key detection', () => {
  it('a C major scale in MIDI is C with confidence > 0.7', () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72];
    const notes = scale.map((pitch, i) => ({ pitch, duration: i === 0 || i === 7 ? 2 : 1, velocity: 0.8 }));
    const k = keyFromProfile(profileFromNotes(notes))!;
    expect(k.key).toBe('C');
    expect(k.confidence).toBeGreaterThan(0.7);
  });
  it('an A minor melody is Am', () => {
    const notes = [57, 60, 64, 57, 59, 60, 62, 64, 57, 64, 57].map((pitch) => ({ pitch, duration: 1, velocity: 0.8 }));
    notes.push({ pitch: 45, duration: 4, velocity: 0.8 }, { pitch: 52, duration: 2, velocity: 0.8 });
    expect(keyFromProfile(profileFromNotes(notes))!.key).toBe('Am');
  });
  it('treats relative keys as the same scale, not as the same key', async () => {
    const { sameKey, sameScale } = await import('./key');
    expect(sameScale('C', 'Am')).toBe(true);
    expect(sameKey('C', 'Am')).toBe(false);
    expect(sameScale('C', 'G')).toBe(false);
  });
  it('knows scale pitch classes', () => {
    expect([...scalePitchClasses('C')].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scalePitchClasses('Am')).toEqual(scalePitchClasses('C'));
  });
});

describe('analyzeAudio', () => {
  it('reports issues for a hot, phase-inverted mix', () => {
    const l = sine(80, 1.05, 2, 44100);
    const r = l.map((x) => -x);
    const res = analyzeAudio({ mix: [l, r], sampleRate: 44100, bpm: 120, projectKey: 'C' }) as { issues: { code: string }[] };
    const codes = res.issues.map((i) => i.code);
    expect(codes).toContain('clipping');
    expect(codes).toContain('phase_mono');
    expect(codes).toContain('true_peak_high');
  });
});
