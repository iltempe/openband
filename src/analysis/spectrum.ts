// Average spectrum: energy per band, spectral centroid and a 1/3-octave curve.
import { binHz, powerSpectrum } from './fft';

export const BANDS = [
  { id: 'sub', lo: 20, hi: 60 },
  { id: 'bass', lo: 60, hi: 250 },
  { id: 'lowmid', lo: 250, hi: 500 },
  { id: 'mid', lo: 500, hi: 2000 },
  { id: 'highmid', lo: 2000, hi: 4000 },
  { id: 'presence', lo: 4000, hi: 6000 },
  { id: 'air', lo: 6000, hi: 20000 },
] as const;
export type BandId = (typeof BANDS)[number]['id'];

/** ISO 1/3-octave centre frequencies, 20 Hz … 20 kHz (31 points). */
export const THIRD_OCTAVES = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

export const FRAME = 4096;
const HOP = 2048;

const dB = (p: number) => (p > 0 ? 10 * Math.log10(p) : -Infinity);

/** Mean power spectrum (Welch) of a signal, FRAME/2+1 bins. */
export function averageSpectrum(x: Float32Array, n = FRAME, hop = HOP): Float64Array {
  const acc = new Float64Array(n / 2 + 1);
  const frame = new Float64Array(n / 2 + 1);
  let frames = 0;
  for (let off = 0; off + n <= Math.max(n, x.length); off += hop) {
    powerSpectrum(x, off, n, frame);
    for (let k = 0; k < acc.length; k++) acc[k] += frame[k];
    frames++;
    if (off + n >= x.length) break;
  }
  for (let k = 0; k < acc.length; k++) acc[k] /= frames || 1;
  return acc;
}

export function bandPowers(spec: Float64Array, sampleRate: number, n = FRAME): Record<BandId, number> {
  const out = {} as Record<BandId, number>;
  for (const b of BANDS) {
    let s = 0;
    for (let k = 1; k < spec.length; k++) {
      const f = binHz(k, n, sampleRate);
      if (f >= b.lo && f < b.hi) s += spec[k];
    }
    out[b.id] = s;
  }
  return out;
}

export const bandsDb = (powers: Record<BandId, number>) =>
  Object.fromEntries(Object.entries(powers).map(([k, v]) => [k, +dB(v).toFixed(1)])) as Record<BandId, number>;

export function centroid(spec: Float64Array, sampleRate: number, n = FRAME): number {
  let num = 0;
  let den = 0;
  for (let k = 1; k < spec.length; k++) {
    num += binHz(k, n, sampleRate) * spec[k];
    den += spec[k];
  }
  return den > 0 ? num / den : 0;
}

/** Energy per 1/3-octave band (dB), 31 points. */
export function thirdOctaves(spec: Float64Array, sampleRate: number, n = FRAME): number[] {
  const k = Math.pow(2, 1 / 6);
  return THIRD_OCTAVES.map((fc) => {
    let s = 0;
    for (let i = 1; i < spec.length; i++) {
      const f = binHz(i, n, sampleRate);
      if (f >= fc / k && f < fc * k) s += spec[i];
    }
    return +dB(s).toFixed(1);
  });
}

/** Mono (mid) mix of the channels. */
export function mono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}
