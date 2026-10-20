// Live loudness (F20): the same BS.1770 measurement as loudness.ts, but streaming. The DSP itself is in
// audio/worklets/loudness-dsp.js (plain JS, copied into the AudioWorklet); here: its types and the targets.

export type BiquadCoeffs = [number, number, number, number, number];

export interface LiveReading {
  /** LUFS, −Infinity while silent or not enough audio yet. */
  momentary: number;
  shortTerm: number;
  integrated: number;
  /** dBTP over the last 400 ms, and the highest since reset. */
  truePeak: number;
  truePeakMax: number;
}

export { StreamingLoudness } from '../audio/worklets/loudness-dsp.js';

// ---------------------------------------------------------------- targets

export interface LoudnessTarget {
  id: 'streaming' | 'apple' | 'broadcast' | 'club';
  lufs: number;
  /** Highest true peak the target accepts, dBTP. */
  ceiling: number;
}
export const TARGETS: LoudnessTarget[] = [
  { id: 'streaming', lufs: -14, ceiling: -1 },
  { id: 'apple', lufs: -16, ceiling: -1 },
  { id: 'broadcast', lufs: -23, ceiling: -1 },
  { id: 'club', lufs: -8, ceiling: -0.3 },
];

/** Green: within 1 LU of the target and under the ceiling; yellow: within 3 LU; red: further, or over the ceiling. */
export function targetStatus(lufs: number, truePeak: number, t: LoudnessTarget): 'green' | 'yellow' | 'red' | 'idle' {
  if (!Number.isFinite(lufs)) return 'idle';
  if (truePeak > t.ceiling) return 'red';
  const d = Math.abs(lufs - t.lufs);
  return d <= 1 ? 'green' : d <= 3 ? 'yellow' : 'red';
}
