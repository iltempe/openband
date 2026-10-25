// Sound-alike (SPEC v0.6 G5): what a note sounds like, in numbers — 10 ms frames of a 64-band log-mel
// spectrum, 13 MFCCs and their deltas, spectral centroid and flatness, the RMS envelope; and how far two
// notes are apart. Pure.
import { powerSpectrum } from '../analysis/fft';

export const HOP_S = 0.01;
const N = 1024;
const MELS = 64;
const COEFFS = 13;

export interface NoteFeatures {
  sampleRate: number;
  /** Per frame: 64 log-mel energies (dB). */
  mel: Float32Array[];
  /** Per frame: 13 MFCCs. */
  mfcc: Float32Array[];
  /** Per frame: RMS (linear) and its dB. */
  rms: Float32Array;
  centroid: Float32Array;
  flatness: Float32Array;
  /** Envelope shape: attack time (s, 10 → 90 % of the peak, measured to 70 %), decay time to the sustain level, the sustain level (0..1 of the peak). */
  attack: number;
  decay: number;
  sustain: number;
  /** Mean MFCCs over the sounding frames. */
  mfccMean: Float32Array;
}

const melOf = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const hzOf = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

const banks = new Map<number, { lo: number; hi: number; w: Float32Array }[]>();
function melBank(sr: number) {
  let b = banks.get(sr);
  if (b) return b;
  const half = N / 2;
  const top = melOf(Math.min(16000, sr / 2));
  const pts = Array.from({ length: MELS + 2 }, (_, i) => hzOf((top * i) / (MELS + 1)));
  const bin = (hz: number) => Math.min(half, Math.round((hz * N) / sr));
  b = Array.from({ length: MELS }, (_, m) => {
    const lo = Math.min(half - 2, bin(pts[m]));
    const mid = Math.min(half - 1, Math.max(lo + 1, bin(pts[m + 1])));
    const hi = Math.min(half, Math.max(mid + 1, bin(pts[m + 2])));
    const w = new Float32Array(hi - lo + 1);
    for (let k = lo; k <= hi; k++) w[k - lo] = k <= mid ? (k - lo) / (mid - lo) : (hi - k) / (hi - mid);
    return { lo, hi, w };
  });
  banks.set(sr, b);
  return b;
}

const dct = Array.from({ length: COEFFS }, (_, c) => Float32Array.from({ length: MELS }, (_, m) => Math.cos((Math.PI * c * (m + 0.5)) / MELS)));

/** The onset: the first frame within 30 dB of the peak (trims silence before the note). */
export function onsetSample(x: Float32Array, sr: number): number {
  const hop = Math.round(sr * 0.002);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const th = peak * 0.0316;
  for (let i = 0; i < x.length; i += hop) {
    let m = 0;
    for (let j = i; j < Math.min(x.length, i + hop); j++) m = Math.max(m, Math.abs(x[j]));
    if (m >= th) return i;
  }
  return 0;
}

/** Features of one note, from its onset, for `seconds` (or to the end). */
export function noteFeatures(x: Float32Array, sr: number, seconds?: number): NoteFeatures {
  const from = onsetSample(x, sr);
  const hop = Math.round(sr * HOP_S);
  const end = seconds ? Math.min(x.length, from + Math.round(seconds * sr)) : x.length;
  const frames = Math.max(1, Math.floor((end - from) / hop));
  const bank = melBank(sr);
  const mel: Float32Array[] = [];
  const mfcc: Float32Array[] = [];
  const rms = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const flatness = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const at = Math.floor(from + f * hop - N / 2 + hop / 2);
    const p = powerSpectrum(x, Math.max(0, at), N);
    let e = 0;
    for (let i = 0; i < hop; i++) {
      const v = x[from + f * hop + i] ?? 0;
      e += v * v;
    }
    rms[f] = Math.sqrt(e / hop);
    let num = 0;
    let den = 0;
    let logSum = 0;
    for (let k = 1; k < p.length; k++) {
      num += p[k] * k;
      den += p[k];
      logSum += Math.log(p[k] + 1e-20);
    }
    centroid[f] = den > 0 ? ((num / den) * sr) / N : 0;
    flatness[f] = den > 0 ? Math.exp(logSum / (p.length - 1)) / (den / (p.length - 1)) : 0;
    const m = new Float32Array(MELS);
    for (let b = 0; b < MELS; b++) {
      let s = 0;
      const { lo, w } = bank[b];
      for (let k = 0; k < w.length && lo + k < p.length; k++) s += p[lo + k] * w[k];
      m[b] = 10 * Math.log10(s + 1e-12);
    }
    mel.push(m);
    const c = new Float32Array(COEFFS);
    for (let i = 0; i < COEFFS; i++) {
      let s = 0;
      for (let b = 0; b < MELS; b++) s += m[b] * dct[i][b];
      c[i] = s / MELS;
    }
    mfcc.push(c);
  }
  // Envelope shape from the RMS.
  let peak = 0;
  let peakAt = 0;
  rms.forEach((v, i) => v > peak && ((peak = v), (peakAt = i)));
  // 10 % → 70 % of the peak, scaled to the usual 10 → 90 %: unison voices beating can push the very top
  // of the envelope far after the attack.
  const t10 = rms.findIndex((v) => v >= peak * 0.1);
  const t70 = rms.findIndex((v) => v >= peak * 0.7);
  const attack = Math.max(0, (t70 - Math.max(0, t10)) * HOP_S * (0.8 / 0.6));
  // Sustain: the level over the last third of the note; decay: when the envelope first gets within 10 % of it above.
  const tail = rms.subarray(Math.floor(frames * 0.6), Math.max(Math.floor(frames * 0.6) + 1, Math.floor(frames * 0.9)));
  const sustainLevel = tail.length ? tail.reduce((s, v) => s + v, 0) / tail.length : 0;
  const sustain = peak > 0 ? sustainLevel / peak : 0;
  let decayAt = peakAt;
  while (decayAt < frames - 1 && rms[decayAt] > sustainLevel + 0.1 * (peak - sustainLevel)) decayAt++;
  const decay = (decayAt - peakAt) * HOP_S;
  // Mean MFCCs over the frames that sound (within 40 dB of the peak).
  const mfccMean = new Float32Array(COEFFS);
  let n = 0;
  mfcc.forEach((c, i) => {
    if (rms[i] < peak * 0.01) return;
    n++;
    for (let k = 0; k < COEFFS; k++) mfccMean[k] += c[k];
  });
  if (n) for (let k = 0; k < COEFFS; k++) mfccMean[k] /= n;
  return { sampleRate: sr, mel, mfcc, rms, centroid, flatness, attack, decay, sustain, mfccMean };
}

/** Dynamic time warping cost between two envelopes (in dB), with a small band: tolerant to timing. */
function dtw(a: Float32Array, b: Float32Array, band = 8): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  const INF = 1e18;
  let prev = new Float64Array(m + 1).fill(INF);
  let cur = new Float64Array(m + 1).fill(INF);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(INF);
    const centre = Math.round((i * m) / n);
    for (let j = Math.max(1, centre - band); j <= Math.min(m, centre + band); j++) {
      const d = Math.abs(a[i - 1] - b[j - 1]);
      cur[j] = d + Math.min(prev[j], prev[j - 1], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / (n + m);
}

const db = (v: Float32Array) => Float32Array.from(v, (x) => 20 * Math.log10(x + 1e-6));

/**
 * How far a candidate is from the target: (a) the log-mel spectra frame by frame from the onset and the
 * envelopes aligned with DTW, (b) the mean MFCCs, (c) the envelope's shape. Levels are matched first
 * (the comparison is about timbre, not loudness). 0 = identical.
 */
export function distance(t: NoteFeatures, c: NoteFeatures): number {
  const frames = Math.min(t.mel.length, c.mel.length);
  // Loudness match: offset the candidate's dB by the difference of the peaks.
  const tp = Math.max(...t.rms);
  const cp = Math.max(...c.rms);
  const off = 20 * Math.log10((tp + 1e-9) / (cp + 1e-9));
  let mel = 0;
  let used = 0;
  for (let f = 0; f < frames; f++) {
    if (t.rms[f] < tp * 0.003) continue;
    let s = 0;
    for (let b = 0; b < MELS; b++) s += Math.abs(Math.max(-90, t.mel[f][b]) - Math.max(-90, c.mel[f][b] + off));
    mel += s / MELS;
    used++;
  }
  mel = used ? mel / used : 0;
  const env = dtw(db(t.rms), Float32Array.from(db(c.rms), (v) => v + off));
  let mf = 0;
  for (let k = 1; k < t.mfccMean.length; k++) mf += Math.abs(t.mfccMean[k] - c.mfccMean[k]);
  mf /= t.mfccMean.length - 1;
  const shape = Math.abs(Math.log((t.attack + 0.005) / (c.attack + 0.005))) * 2 + Math.abs(Math.log((t.decay + 0.02) / (c.decay + 0.02))) + Math.abs(t.sustain - c.sustain) * 4;
  // Brightness over time (the filter's movement): centroid in octaves.
  let cen = 0;
  for (let f = 0; f < frames; f++) if (t.rms[f] >= tp * 0.01 && t.centroid[f] > 0 && c.centroid[f] > 0) cen += Math.abs(Math.log2(t.centroid[f] / c.centroid[f]));
  cen /= Math.max(1, frames);
  return mel * 0.06 + env * 0.05 + mf * 0.08 + shape * 0.25 + cen * 0.8;
}

/** 0..1 from a distance: 1 = identical. */
export const similarity = (d: number) => Math.exp(-d / 1.2);
