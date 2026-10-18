// Key detection: Krumhansl–Schmuckler on a pitch-class profile, from MIDI notes or from audio.
import { binHz, powerSpectrum } from './fft';

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

export interface KeyResult {
  key: string;
  /** Correlation of the best key with the profile, 0 … 1. */
  confidence: number;
  alternatives: { key: string; confidence: number }[];
}

function pearson(a: number[], b: number[]) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    dbb += (b[i] - mb) ** 2;
  }
  return da > 0 && dbb > 0 ? num / Math.sqrt(da * dbb) : 0;
}

export function keyFromProfile(profile: number[]): KeyResult | null {
  if (profile.every((x) => x <= 0)) return null;
  const scores: { key: string; r: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = profile.map((_, i) => profile[(i + tonic) % 12]);
    scores.push({ key: NAMES[tonic], r: pearson(rot, MAJOR) });
    scores.push({ key: MINOR_NAMES[tonic], r: pearson(rot, MINOR) });
  }
  scores.sort((a, b) => b.r - a.r);
  const c = (r: number) => +Math.max(0, r).toFixed(2);
  return { key: scores[0].key, confidence: c(scores[0].r), alternatives: scores.slice(1, 3).map((s) => ({ key: s.key, confidence: c(s.r) })) };
}

/** Pitch-class histogram weighted by duration × velocity. */
export function profileFromNotes(notes: { pitch: number; duration: number; velocity: number }[]): number[] {
  const h = new Array(12).fill(0);
  for (const n of notes) h[n.pitch % 12] += n.duration * n.velocity;
  return h;
}

/** Chromagram of an audio signal (50 Hz … 5 kHz), summed over time. */
export function profileFromAudio(x: Float32Array, sampleRate: number): number[] {
  const N = 8192;
  const h = new Array(12).fill(0);
  const spec = new Float64Array(N / 2 + 1);
  for (let off = 0; off + N <= x.length; off += N / 2) {
    powerSpectrum(x, off, N, spec);
    for (let k = 1; k < spec.length; k++) {
      const f = binHz(k, N, sampleRate);
      if (f < 50 || f > 5000) continue;
      const pc = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
      h[pc] += Math.sqrt(spec[k]);
    }
  }
  return h;
}

/** Pitch classes of a key's scale (major, or natural + harmonic minor's leading tone excluded). */
export function scalePitchClasses(key: string): Set<number> {
  const minor = key.endsWith('m');
  const root = key.replace(/m$/, '');
  const alias: Record<string, string> = { Db: 'C#', 'D#': 'Eb', Gb: 'F#', 'G#': 'Ab', 'A#': 'Bb' };
  const tonic = NAMES.indexOf(alias[root] ?? root);
  if (tonic < 0) return new Set();
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return new Set(steps.map((s) => (tonic + s) % 12));
}

/** Same notes (e.g. C and Am, relative keys). */
export const sameScale = (a: string, b: string) => [...scalePitchClasses(a)].sort().join() === [...scalePitchClasses(b)].sort().join();

export const sameKey = (a: string, b: string) => {
  const sa = [...scalePitchClasses(a)].sort().join();
  return a.endsWith('m') === b.endsWith('m') && sa === [...scalePitchClasses(b)].sort().join();
};
