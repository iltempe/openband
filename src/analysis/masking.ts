// Spectral masking between stems: where two tracks fight for the same frequencies at the same time.
import { binHz, powerSpectrum } from './fft';
import { BANDS, type BandId } from './spectrum';

export interface MaskingPair {
  a: string;
  b: string;
  band: BandId;
  /** 0 … 1: share of the band's energy where both stems overlap while both are playing. */
  score: number;
}

const N = 2048;
const HOP = 2048;
const ACTIVE = Math.pow(10, -50 / 10); // −50 dBFS in power
const sum = (a: Float64Array) => a.reduce((x, y) => x + y, 0);

/** Band energies per frame for one mono signal: frames × bands. */
export function bandFrames(x: Float32Array, sampleRate: number): Float64Array[] {
  const bins = BANDS.map((b) => {
    const ks: number[] = [];
    for (let k = 1; k <= N / 2; k++) {
      const f = binHz(k, N, sampleRate);
      if (f >= b.lo && f < b.hi) ks.push(k);
    }
    return ks;
  });
  const frames: Float64Array[] = [];
  const spec = new Float64Array(N / 2 + 1);
  for (let off = 0; off < x.length; off += HOP) {
    powerSpectrum(x, off, N, spec);
    const e = new Float64Array(BANDS.length);
    bins.forEach((ks, bi) => {
      let s = 0;
      for (const k of ks) s += spec[k];
      e[bi] = s;
    });
    frames.push(e);
  }
  return frames;
}

/**
 * For each pair of stems and each band: Σ min(Ea, Eb) over the frames where both are active,
 * divided by the energy of all stems in that band over those frames (the mix energy, assuming the
 * stems are uncorrelated), ×2 so that two identical stems score 1.
 */
export function masking(stems: { name: string; frames: Float64Array[] }[], top = 5): MaskingPair[] {
  const pairs: MaskingPair[] = [];
  const frameCount = Math.min(...stems.map((s) => s.frames.length));
  for (let i = 0; i < stems.length; i++) {
    for (let j = i + 1; j < stems.length; j++) {
      BANDS.forEach((band, bi) => {
        let overlap = 0;
        let total = 0;
        for (let f = 0; f < frameCount; f++) {
          const ea = stems[i].frames[f][bi];
          const eb = stems[j].frames[f][bi];
          if (ea < ACTIVE || eb < ACTIVE) continue;
          // Ignore bands that are only spectral leakage for either stem (< 5% of its energy).
          if (ea < 0.05 * sum(stems[i].frames[f]) || eb < 0.05 * sum(stems[j].frames[f])) continue;
          overlap += Math.min(ea, eb);
          for (const s of stems) total += s.frames[f][bi];
        }
        const score = total > 0 ? Math.min(1, (2 * overlap) / total) : 0;
        if (score > 0.05) pairs.push({ a: stems[i].name, b: stems[j].name, band: band.id, score: +score.toFixed(2) });
      });
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, top);
}
