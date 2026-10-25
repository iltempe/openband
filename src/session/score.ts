// Session mode (SPEC v0.6 G4): scoring takes bar by bar, choosing the best take for each bar, and the
// audio comp that joins them. Pure.
import { yinTrack } from '../analysis/pitchtrack';

export interface BarScore {
  /** 0..100: higher is better. */
  score: number;
  /** Mean |cents| from the guide melody (null without a guide or without voiced frames). */
  cents: number | null;
  /** Mean |ms| of the onsets from the nearest sixteenth. */
  timingMs: number | null;
  /** Clipped samples. */
  clipped: number;
  /** Out-of-scale notes (MIDI). */
  outOfKey?: number;
  /** Nothing played in the bar. */
  silent: boolean;
}

export interface GuideNote {
  /** Seconds from the take's start. */
  start: number;
  end: number;
  pitch: number;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Onsets (s): rises of the 10 ms energy envelope (a simple, robust detector for one instrument or voice). */
export function onsets(x: Float32Array, sr: number): number[] {
  const hop = Math.round(sr * 0.01);
  const env: number[] = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let e = 0;
    for (let j = i; j < i + hop; j++) e += x[j] * x[j];
    env.push(Math.sqrt(e / hop));
  }
  const peak = Math.max(1e-9, ...env);
  const out: number[] = [];
  let last = -1;
  for (let k = 0; k < env.length; k++) {
    const rise = env[k] - (env[k - 2] ?? 0);
    if (rise > peak * 0.15 && env[k] > peak * 0.2 && (last < 0 || k - last > 8)) {
      out.push((k * hop) / sr);
      last = k;
    }
  }
  return out;
}

/**
 * Per bar of an audio take: pitch against the guide (when there is one), onset timing against the
 * sixteenths, clipping. spb: seconds per beat; beatsPerBar: 4.
 */
export function audioBarScores(x: Float32Array, sr: number, o: { bars: number; spb: number; beatsPerBar?: number; guide?: GuideNote[] }): BarScore[] {
  const bpb = o.beatsPerBar ?? 4;
  const barS = o.spb * bpb;
  const frames = o.guide?.length ? yinTrack(x, sr, { minHz: 60, maxHz: 1100 }) : [];
  const ons = onsets(x, sr);
  const six = o.spb / 4;
  const out: BarScore[] = [];
  for (let b = 0; b < o.bars; b++) {
    const t0 = b * barS;
    const t1 = t0 + barS;
    const a = Math.round(t0 * sr);
    const z = Math.min(x.length, Math.round(t1 * sr));
    let e = 0;
    let clipped = 0;
    for (let i = a; i < z; i++) {
      e += x[i] * x[i];
      if (Math.abs(x[i]) >= 0.99) clipped++;
    }
    const rms = Math.sqrt(e / Math.max(1, z - a));
    const silent = rms < 0.003;
    // Pitch: voiced frames inside guide notes, distance in cents (octave errors forgiven).
    const dev: number[] = [];
    for (const f of frames) {
      if (f.time < t0 || f.time >= t1 || f.midi === null || f.aperiodicity > 0.35) continue;
      const g = o.guide!.find((n) => f.time >= n.start + 0.05 && f.time < n.end - 0.03);
      if (!g) continue;
      let d = (f.midi - g.pitch) * 100;
      d -= Math.round(d / 1200) * 1200;
      dev.push(Math.abs(d));
    }
    const cents = dev.length >= 3 ? dev.reduce((s, v) => s + v, 0) / dev.length : null;
    const barOns = ons.filter((t) => t >= t0 && t < t1);
    const timingMs = barOns.length ? (barOns.reduce((s, t) => s + Math.abs(t - Math.round(t / six) * six), 0) / barOns.length) * 1000 : null;
    let score = 100;
    if (cents !== null) score -= clamp((cents - 10) * 0.6, 0, 60);
    if (timingMs !== null) score -= clamp((timingMs - 10) * 0.8, 0, 40);
    score -= clamp(clipped / 20, 0, 30);
    if (silent) score = 5;
    out.push({ score: Math.round(clamp(score, 0, 100)), cents: cents === null ? null : Math.round(cents), timingMs: timingMs === null ? null : Math.round(timingMs), clipped, silent });
  }
  return out;
}

/** Per bar of a MIDI take: timing against the sixteenths (in beats) and notes out of the key. */
export function midiBarScores(notes: { start: number; pitch: number }[], o: { bars: number; spb: number; beatsPerBar?: number; scale: Set<number> }): BarScore[] {
  const bpb = o.beatsPerBar ?? 4;
  return Array.from({ length: o.bars }, (_, b) => {
    const ns = notes.filter((n) => n.start >= b * bpb && n.start < (b + 1) * bpb);
    const timing = ns.length ? (ns.reduce((s, n) => s + Math.abs(n.start - Math.round(n.start * 4) / 4), 0) / ns.length) * o.spb * 1000 : null;
    const outOfKey = ns.filter((n) => !o.scale.has(((n.pitch % 12) + 12) % 12)).length;
    let score = 100;
    if (timing !== null) score -= clamp((timing - 10) * 0.8, 0, 40);
    score -= outOfKey * 15;
    if (!ns.length) score = 5;
    return { score: Math.round(clamp(score, 0, 100)), cents: null, timingMs: timing === null ? null : Math.round(timing), clipped: 0, outOfKey, silent: !ns.length };
  });
}

/**
 * The take for each bar: its score, minus a lot for a mistake marked there (a flub), plus a little for a
 * "good" mark. marks[take][bar] = { flubs, goods }. Ties keep the previous bar's take (fewer joins).
 */
export function chooseComp(scores: BarScore[][], marks: { flubs: number; goods: number }[][]): number[] {
  const bars = Math.max(0, ...scores.map((s) => s.length));
  const pick: number[] = [];
  for (let b = 0; b < bars; b++) {
    let best = -1;
    let bestV = -Infinity;
    scores.forEach((s, t) => {
      const m = marks[t]?.[b] ?? { flubs: 0, goods: 0 };
      const v = (s[b]?.score ?? 0) - 60 * m.flubs + 8 * m.goods + (pick[b - 1] === t ? 0.5 : 0);
      if (v > bestV) [best, bestV] = [t, v];
    });
    pick.push(best);
  }
  return pick;
}

/** A take's overall score: the mean of its bars, flubs counted. */
export function takeScore(s: BarScore[], m: { flubs: number; goods: number }[]): number {
  if (!s.length) return 0;
  return Math.round(s.reduce((sum, b, i) => sum + clamp(b.score - 60 * (m[i]?.flubs ?? 0) + 8 * (m[i]?.goods ?? 0), 0, 100), 0) / s.length);
}

/** The audio comp: each bar from its take, joined by equal-power crossfades of `fade` samples. */
export function compAudio(takes: Float32Array[], pick: number[], barSamples: number, fade: number): Float32Array {
  const n = Math.max(...takes.map((t) => t.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const bar = Math.min(pick.length - 1, Math.floor(i / barSamples));
    const into = i - bar * barSamples;
    let v = takes[pick[bar]]?.[i] ?? 0;
    // Crossfade over the join with the previous bar's take, centred on the bar line.
    if (bar > 0 && pick[bar] !== pick[bar - 1] && into < fade / 2) {
      const w = (into + fade / 2) / fade;
      v = Math.sin((w * Math.PI) / 2) * v + Math.cos((w * Math.PI) / 2) * (takes[pick[bar - 1]]?.[i] ?? 0);
    } else if (bar + 1 < pick.length && pick[bar + 1] !== pick[bar] && barSamples - into <= fade / 2) {
      const w = (fade / 2 - (barSamples - into)) / fade;
      v = Math.cos((w * Math.PI) / 2) * v + Math.sin((w * Math.PI) / 2) * (takes[pick[bar + 1]]?.[i] ?? 0);
    }
    out[i] = v;
  }
  return out;
}

/** Silence spans of a take (in samples), with fades of `fade` samples on both sides. */
export function silenceSpans(x: Float32Array, spans: { from: number; to: number }[], fade: number): Float32Array {
  for (const s of spans) {
    const a = Math.max(0, Math.floor(s.from));
    const z = Math.min(x.length, Math.ceil(s.to));
    if (z <= a) continue;
    for (let i = Math.max(0, a - fade); i < Math.min(x.length, z + fade); i++) {
      const g = i < a ? (a - i) / fade : i >= z ? (i - z + 1) / fade : 0;
      x[i] *= Math.min(1, g);
    }
  }
  return x;
}
