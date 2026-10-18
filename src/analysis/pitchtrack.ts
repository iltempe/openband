// Monophonic pitch tracking (YIN) and note segmentation: audio → MIDI notes. Pure.
import { fft } from './fft';

export interface PitchFrame {
  /** Seconds (centre of the analysis window). */
  time: number;
  /** Fractional MIDI pitch, or null when unvoiced. */
  midi: number | null;
  /** YIN aperiodicity 0 (clean) … 1. */
  aperiodicity: number;
  /** RMS level of the hop, dB. */
  db: number;
}

export interface TrackedNote {
  /** Seconds. */
  start: number;
  duration: number;
  pitch: number;
  velocity: number;
}

export interface YinOptions {
  threshold?: number;
  minHz?: number;
  maxHz?: number;
  /** Analysis hop in samples at 44.1 kHz (scaled for other rates). */
  hop?: number;
}

const nextPow2 = (n: number) => 1 << Math.ceil(Math.log2(n));

/**
 * YIN pitch per frame: window W = 1024 samples (at 44.1 kHz) plus the largest lag, hop 256.
 * The difference function is computed from an FFT cross-correlation, so it stays fast.
 */
export function yinTrack(x: Float32Array, sampleRate: number, o: YinOptions = {}): PitchFrame[] {
  const scale = sampleRate / 44100;
  const W = Math.round(1024 * scale);
  const hop = Math.max(1, Math.round((o.hop ?? 256) * scale));
  const tauMin = Math.max(2, Math.floor(sampleRate / (o.maxHz ?? 1100)));
  const tauMax = Math.min(W - 1, Math.ceil(sampleRate / (o.minHz ?? 70)));
  const threshold = o.threshold ?? 0.15;
  const frameLen = W + tauMax + 1;
  const N = nextPow2(W + frameLen);
  // Prefix sums of x² for the window energies.
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  const energy = (from: number, len: number) => sq[Math.min(x.length, from + len)] - sq[Math.min(x.length, from)];

  const frames: PitchFrame[] = [];
  const are = new Float64Array(N), aim = new Float64Array(N), bre = new Float64Array(N), bim = new Float64Array(N);
  const d = new Float64Array(tauMax + 1);
  for (let start = 0; start + W <= x.length; start += hop) {
    are.fill(0); aim.fill(0); bre.fill(0); bim.fill(0);
    for (let i = 0; i < W; i++) are[i] = x[start + i];
    for (let i = 0; i < frameLen && start + i < x.length; i++) bre[i] = x[start + i];
    fft(are, aim);
    fft(bre, bim);
    // r(τ) = Σ a_j b_{j+τ}  →  IFFT(conj(A)·B), with the inverse done as conj(FFT(conj(·)))/N.
    for (let k = 0; k < N; k++) {
      const r = are[k] * bre[k] + aim[k] * bim[k];
      const i = are[k] * bim[k] - aim[k] * bre[k];
      bre[k] = r;
      bim[k] = -i;
    }
    fft(bre, bim);
    const e0 = energy(start, W);
    let running = 0;
    d[0] = 1;
    let best = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      const r = bre[tau] / N;
      const diff = e0 + energy(start + tau, W) - 2 * r;
      running += diff;
      d[tau] = running > 0 ? (diff * tau) / running : 1;
    }
    // First dip under the threshold (then its local minimum); otherwise the global minimum.
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < threshold) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    let ap = best >= 0 ? d[best] : 1;
    if (best < 0) {
      let m = Infinity;
      for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < m) {
        m = d[tau];
        best = tau;
      }
      ap = m;
    }
    const rms = Math.sqrt(energy(start + W / 2 - hop / 2, hop) / hop);
    const db = rms > 0 ? 20 * Math.log10(rms) : -120;
    let midi: number | null = null;
    if (best > 0 && ap < 0.35 && db > -55) {
      // Parabolic interpolation around the minimum.
      const a = d[best - 1] ?? d[best];
      const b = d[best];
      const c = d[best + 1] ?? d[best];
      const den = a - 2 * b + c;
      const tau = best + (den ? (a - c) / (2 * den) : 0);
      midi = 69 + 12 * Math.log2(sampleRate / tau / 440);
    }
    frames.push({ time: (start + W / 2) / sampleRate, midi, aperiodicity: +ap.toFixed(3), db });
  }
  return frames;
}

/** Median of the voiced values over a 5-frame window (removes octave blips). */
export function smooth(frames: PitchFrame[]): PitchFrame[] {
  return frames.map((f, i) => {
    if (f.midi === null) return f;
    const win = frames.slice(Math.max(0, i - 2), i + 3).map((x) => x.midi).filter((m): m is number => m !== null).sort((a, b) => a - b);
    return { ...f, midi: win[Math.floor(win.length / 2)] };
  });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export interface SegmentOptions {
  /** Minimum note length, seconds (default 0.08). */
  minDuration?: number;
  /** A pitch held on a different semitone this long starts a new note (default 0.06 s). */
  stableChange?: number;
  /** Energy jump that starts a new note (default 6 dB within 30 ms). */
  onsetDb?: number;
}

/** Cut a pitch track into notes (onsets from silence, energy jumps or a new stable pitch). */
export function segmentNotes(frames: PitchFrame[], o: SegmentOptions = {}): TrackedNote[] {
  if (frames.length < 2) return [];
  const dt = frames[1].time - frames[0].time;
  const minDur = o.minDuration ?? 0.08;
  const stableFrames = Math.max(1, Math.round((o.stableChange ?? 0.06) / dt));
  const lag = Math.max(1, Math.round(0.03 / dt));
  const jump = o.onsetDb ?? 6;
  const raw: { from: number; to: number; pitches: number[]; dbs: number[] }[] = [];
  let cur: (typeof raw)[number] | null = null;
  const close = (end: number) => {
    if (cur) {
      cur.to = end;
      raw.push(cur);
    }
    cur = null;
  };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.midi === null) {
      close(i);
      continue;
    }
    if (!cur) {
      cur = { from: i, to: i, pitches: [f.midi], dbs: [f.db] };
      continue;
    }
    const semi = Math.round(median(cur.pitches));
    // New stable pitch: the next `stableFrames` frames all sit on another semitone.
    const ahead = frames.slice(i, i + stableFrames);
    const moved = Math.round(f.midi) !== semi && ahead.length === stableFrames && ahead.every((x) => x.midi !== null && Math.round(x.midi) === Math.round(f.midi!));
    const attack = i >= lag && f.db - frames[i - lag].db > jump && cur.pitches.length * dt > minDur;
    if (moved || attack) {
      close(i);
      cur = { from: i, to: i, pitches: [f.midi], dbs: [f.db] };
      continue;
    }
    cur.pitches.push(f.midi);
    cur.dbs.push(f.db);
  }
  close(frames.length);
  // Times: a note starts half a hop before its first frame's centre.
  const t0 = (i: number) => frames[Math.min(i, frames.length - 1)].time - dt / 2;
  const notes = raw
    .map((r) => {
      const level = Math.max(...r.dbs);
      return { start: Math.max(0, t0(r.from)), duration: t0(r.to) - t0(r.from), pitch: Math.round(median(r.pitches)), level };
    })
    .filter((n) => n.duration >= minDur);
  const loud = Math.max(-120, ...notes.map((n) => n.level));
  return notes.map((n) => ({ start: +n.start.toFixed(4), duration: +n.duration.toFixed(4), pitch: n.pitch, velocity: +Math.min(1, Math.max(0.2, 0.9 + (n.level - loud) / 40)).toFixed(2) }));
}

/** Audio → notes, in seconds. */
export function audioToNotes(x: Float32Array, sampleRate: number, o: YinOptions & SegmentOptions = {}): TrackedNote[] {
  return segmentNotes(smooth(yinTrack(x, sampleRate, o)), o);
}

/** Nearest pitch whose pitch class is in the scale (ties go down). */
export function snapToScale(pitch: number, scale: Set<number>): number {
  if (!scale.size || scale.has(((pitch % 12) + 12) % 12)) return pitch;
  for (let k = 1; k < 7; k++) {
    if (scale.has((((pitch - k) % 12) + 12) % 12)) return pitch - k;
    if (scale.has((pitch + k) % 12)) return pitch + k;
  }
  return pitch;
}

/** Move starts (and ends) towards the grid by `strength` (0 … 1). Times in beats. */
export function quantizeNotes<T extends { start: number; duration: number }>(notes: T[], grid: number, strength = 1): T[] {
  const q = (t: number) => t + (Math.round(t / grid) * grid - t) * strength;
  return notes.map((n) => {
    const start = q(n.start);
    const end = Math.max(start + grid * 0.5, q(n.start + n.duration));
    return { ...n, start: +start.toFixed(4), duration: +(end - start).toFixed(4) };
  });
}
