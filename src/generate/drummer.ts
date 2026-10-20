// The drummer (F24): deterministic drum parts, no LLM — fast, repeatable (same seed → same part).
// Each style is a small grammar: per-step probabilities for each piece over a bar of 16 steps, with
// optional extra hits that complexity unlocks, ghost notes, humanized velocities and timing, swing,
// fills at the end of sections and a crash after them. It follows the song: simpler in verses, fuller
// in choruses (the section's energy scales complexity and loudness). Pure: no store, no audio.
import type { Note, SectionKind } from '../types';
import { BEATS_PER_BAR } from '../music';

export const DRUM_STYLES = ['rock', 'pop', 'funk', 'boom-bap', 'trap', 'lo-fi', 'house', 'bossa', 'ballad', 'shuffle'] as const;
export type DrumStyle = (typeof DRUM_STYLES)[number];
export type Fills = 'none' | 'end_of_section' | 'every_4';

export interface DrummerOptions {
  style: DrumStyle;
  /** 0 = the bare groove, 1 = every variation the style has. */
  complexity: number;
  /** 0 = brushes, 1 = hard. */
  loudness: number;
  /** 0 = straight, 1 = full triplet swing (on 16ths; 8ths for shuffle). */
  swing: number;
  fills: Fills;
  seed: number;
}

/** A stretch of the song to play, with its character (sections from F8). */
export interface DrumSpan {
  /** Beats from the song start. */
  start: number;
  bars: number;
  kind?: SectionKind;
}

const K = 36;
const RIM = 37;
const S = 38;
const CLAP = 39;
const HH = 42;
const LT = 45;
const OH = 46;
const MT = 48;
const CR = 49;
const HT = 50;
const RD = 51;

/**
 * A step pattern: 16 characters per piece. Digits are probabilities ×10 ("9" = 90%, "x" = always),
 * "g" a ghost note (soft), "." nothing. Lines marked `extra` only play as complexity rises.
 */
interface Line {
  pitch: number;
  steps: string;
  vel: number;
  extra?: boolean;
}
interface StyleDef {
  lines: Line[];
  /** Fill vocabulary for the last beat(s) of a section. */
  fill: 'toms' | 'snare' | 'rolls' | 'none';
  /** Swing applies to 8ths (shuffle) or 16ths. */
  swingOn: 8 | 16;
  /** A suggested tempo, for docs and defaults. */
  bpm: number;
}

const STYLES: Record<DrumStyle, StyleDef> = {
  rock: {
    bpm: 120,
    fill: 'toms',
    swingOn: 16,
    lines: [
      { pitch: K, steps: 'x.....x.x.......', vel: 0.95 },
      { pitch: K, steps: '.......3......2.', vel: 0.8, extra: true },
      { pitch: S, steps: '....x.......x...', vel: 0.95 },
      { pitch: S, steps: '.......g..g....g', vel: 0.3, extra: true },
      { pitch: HH, steps: 'x.x.x.x.x.x.x.x.', vel: 0.7 },
      { pitch: HH, steps: '.3.3.3.3.3.3.3.3', vel: 0.45, extra: true },
    ],
  },
  pop: {
    bpm: 110,
    fill: 'snare',
    swingOn: 16,
    lines: [
      { pitch: K, steps: 'x.......x.x.....', vel: 0.9 },
      { pitch: K, steps: '......4.......3.', vel: 0.75, extra: true },
      { pitch: CLAP, steps: '....x.......x...', vel: 0.85 },
      { pitch: S, steps: '....x.......x...', vel: 0.6 },
      { pitch: HH, steps: 'x.x.x.x.x.x.x.x.', vel: 0.6 },
      { pitch: OH, steps: '..............5.', vel: 0.55, extra: true },
    ],
  },
  funk: {
    bpm: 100,
    fill: 'snare',
    swingOn: 16,
    lines: [
      { pitch: K, steps: 'x..x..x...x..4..', vel: 0.95 },
      { pitch: S, steps: '....x..g.g..x..g', vel: 0.95 },
      { pitch: S, steps: '.g.......g.g.g..', vel: 0.28, extra: true },
      { pitch: HH, steps: 'xxxxxxxxxxxxxxxx', vel: 0.55 },
      { pitch: OH, steps: '......5.......5.', vel: 0.6, extra: true },
    ],
  },
  'boom-bap': {
    bpm: 90,
    fill: 'none',
    swingOn: 16,
    lines: [
      { pitch: K, steps: 'x......x..x.....', vel: 1 },
      { pitch: K, steps: '.........4....3.', vel: 0.8, extra: true },
      { pitch: S, steps: '....x.......x...', vel: 1 },
      { pitch: HH, steps: 'x.x.x.x.x.x.x.x.', vel: 0.6 },
      { pitch: HH, steps: '.....3.......3..', vel: 0.4, extra: true },
      { pitch: RIM, steps: '...........3....', vel: 0.5, extra: true },
    ],
  },
  trap: {
    bpm: 140,
    fill: 'rolls',
    swingOn: 16,
    lines: [
      { pitch: K, steps: 'x......x..x.....', vel: 1 },
      { pitch: K, steps: '...4......4..4..', vel: 0.9, extra: true },
      { pitch: CLAP, steps: '........x.......', vel: 1 },
      { pitch: HH, steps: 'xxxxxxxxxxxxxxxx', vel: 0.55 },
      { pitch: OH, steps: '...............4', vel: 0.6, extra: true },
    ],
  },
  'lo-fi': {
    bpm: 82,
    fill: 'none',
    swingOn: 16,
    lines: [
      { pitch: K, steps: 'x......x..x.....', vel: 0.85 },
      { pitch: S, steps: '....x.......x...', vel: 0.75 },
      { pitch: S, steps: '..........g.....', vel: 0.25, extra: true },
      { pitch: HH, steps: 'x.x.x.x.x.x.x.x.', vel: 0.45 },
      { pitch: RIM, steps: '.......3.......3', vel: 0.35, extra: true },
    ],
  },
  house: {
    bpm: 124,
    fill: 'snare',
    swingOn: 16,
    lines: [
      { pitch: K, steps: 'x...x...x...x...', vel: 1 },
      { pitch: CLAP, steps: '....x.......x...', vel: 0.85 },
      { pitch: OH, steps: '..x...x...x...x.', vel: 0.7 },
      { pitch: HH, steps: 'x.xxx.xxx.xxx.xx', vel: 0.45, extra: true },
      { pitch: RD, steps: '...3.......3....', vel: 0.4, extra: true },
    ],
  },
  bossa: {
    bpm: 130,
    fill: 'none',
    swingOn: 16,
    lines: [
      { pitch: K, steps: 'x..x x..x..x x..'.replace(/ /g, '.'), vel: 0.7 },
      { pitch: RIM, steps: 'x..x..x...x..x..', vel: 0.65 },
      { pitch: HH, steps: 'x.x.x.x.x.x.x.x.', vel: 0.4 },
      { pitch: HH, steps: '.3.3.3.3.3.3.3.3', vel: 0.3, extra: true },
    ],
  },
  ballad: {
    bpm: 72,
    fill: 'toms',
    swingOn: 16,
    lines: [
      { pitch: K, steps: 'x.........x.....', vel: 0.75 },
      { pitch: K, steps: '.......3........', vel: 0.6, extra: true },
      { pitch: S, steps: '....x.......x...', vel: 0.7 },
      { pitch: HH, steps: 'x.x.x.x.x.x.x.x.', vel: 0.4 },
      { pitch: RD, steps: '..3.......3.....', vel: 0.35, extra: true },
    ],
  },
  shuffle: {
    bpm: 110,
    fill: 'snare',
    swingOn: 8,
    lines: [
      { pitch: K, steps: 'x.......x.x.....', vel: 0.9 },
      { pitch: S, steps: '....x.......x...', vel: 0.9 },
      { pitch: S, steps: '......g.......g.', vel: 0.3, extra: true },
      { pitch: HH, steps: 'x.x.x.x.x.x.x.x.', vel: 0.6 },
      { pitch: RD, steps: '..3...3...3...3.', vel: 0.4, extra: true },
    ],
  },
};
export const styleBpm = (s: DrumStyle) => STYLES[s].bpm;

/** mulberry32: a small seeded PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How full a section feels: verses simpler, choruses fuller. */
const ENERGY: Record<SectionKind, number> = { intro: 0.35, verse: 0.5, prechorus: 0.65, chorus: 0.9, bridge: 0.6, solo: 0.8, breakdown: 0.25, outro: 0.45, custom: 0.6 };

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

function fillNotes(kind: StyleDef['fill'], beats: number, at: number, vel: number, r: () => number): Note[] {
  if (kind === 'none') return [];
  const out: Note[] = [];
  const steps = Math.round(beats * 4);
  for (let i = 0; i < steps; i++) {
    const t = at + i / 4;
    const p = kind === 'toms' ? [HT, HT, MT, MT, LT, LT, LT, K][Math.floor((i / steps) * 8)] : S;
    if (kind === 'rolls') {
      // 32nd rolls on the hats, rising
      for (const sub of [0, 0.125]) out.push({ id: '', pitch: HH, start: t + sub, duration: 0.1, velocity: clamp(vel * (0.5 + (0.5 * i) / steps)) });
      continue;
    }
    if (i % 2 === 1 && r() < 0.35) continue;
    out.push({ id: '', pitch: p, start: t, duration: 0.25, velocity: clamp(vel * (0.65 + (0.35 * i) / steps)) });
  }
  return out;
}

/**
 * Drum notes for the spans (beats from the song start). The same options and spans always give the
 * same notes.
 */
export function generateDrums(spans: DrumSpan[], o: DrummerOptions): Note[] {
  const def = STYLES[o.style];
  const r = rng(o.seed);
  const out: Note[] = [];
  let barIndex = 0;
  spans.forEach((span, si) => {
    const energy = span.kind ? ENERGY[span.kind] : 0.6;
    const complexity = clamp(o.complexity * (0.5 + energy));
    const loud = clamp(0.35 + 0.65 * o.loudness * (0.75 + 0.5 * energy));
    for (let b = 0; b < span.bars; b++, barIndex++) {
      const barStart = span.start + b * BEATS_PER_BAR;
      const lastBar = b === span.bars - 1;
      const fillHere = o.fills === 'end_of_section' ? lastBar : o.fills === 'every_4' ? barIndex % 4 === 3 : false;
      // How much of the bar the fill takes: one beat, two with high complexity.
      const fillBeats = fillHere && def.fill !== 'none' ? (complexity > 0.6 ? 2 : 1) : 0;
      const fillFrom = BEATS_PER_BAR - fillBeats;
      for (const line of def.lines) {
        if (line.extra && r() > complexity) continue;
        for (let step = 0; step < 16; step++) {
          const ch = line.steps[step];
          if (ch === '.' || !ch) continue;
          const pos = step / 4;
          if (fillBeats && pos >= fillFrom && line.pitch !== HH && line.pitch !== RD) continue;
          const ghost = ch === 'g';
          const prob = ch === 'x' || ghost ? 1 : Number(ch) / 10;
          if (r() > prob * (ghost ? clamp(0.3 + complexity) : 1)) continue;
          // Swing: delay the off-beat 16ths (or 8ths), up to a triplet.
          const off = def.swingOn === 8 ? step % 4 === 2 : step % 2 === 1;
          const swing = off ? (o.swing * (def.swingOn === 8 ? 0.5 : 0.25)) / 3 : 0;
          // Humanize: a little timing and velocity variation; accents on the beat.
          const accent = step % 4 === 0 ? 1 : step % 2 === 0 ? 0.9 : 0.8;
          const vel = clamp((ghost ? line.vel : line.vel * accent) * loud * (0.92 + r() * 0.16), 0.05, 1);
          const jitter = (r() - 0.5) * 0.02;
          out.push({ id: '', pitch: line.pitch, start: +(barStart + pos + swing + (step ? jitter : 0)).toFixed(4), duration: line.pitch === OH || line.pitch === CR ? 0.5 : 0.25, velocity: +vel.toFixed(3) });
        }
      }
      if (fillBeats) out.push(...fillNotes(def.fill, fillBeats, barStart + fillFrom, loud, r));
      // A crash on the downbeat after a fill, and at the start of a new section.
      const sectionStart = b === 0 && si > 0;
      const afterFill = barIndex > 0 && (o.fills === 'every_4' ? (barIndex - 1) % 4 === 3 : false);
      if ((sectionStart || afterFill) && def.fill !== 'none') out.push({ id: '', pitch: CR, start: barStart, duration: 1, velocity: +clamp(loud * 0.9).toFixed(3) });
    }
  });
  return merged(out);
}

/** One hit per drum within a 32nd note (two pattern lines can land on the same step): the louder stays. */
function merged(notes: Note[]): Note[] {
  const sorted = notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const last = new Map<number, Note>();
  const out: Note[] = [];
  for (const n of sorted) {
    const prev = last.get(n.pitch);
    if (prev && n.start - prev.start < 0.125) {
      prev.velocity = Math.max(prev.velocity, n.velocity);
      continue;
    }
    last.set(n.pitch, n);
    out.push(n);
  }
  return out;
}

/** Bars × spans from sections in a range (or one plain span). */
export function spansFor(sections: { start: number; length: number; kind: SectionKind }[], from: number, to: number): DrumSpan[] {
  const inside = sections.filter((s) => s.start < to - 1e-9 && s.start + s.length > from + 1e-9).sort((a, b) => a.start - b.start);
  if (!inside.length) return [{ start: from, bars: Math.max(1, Math.round((to - from) / BEATS_PER_BAR)) }];
  const spans: DrumSpan[] = [];
  let at = from;
  for (const s of inside) {
    const a = Math.max(from, s.start);
    const e = Math.min(to, s.start + s.length);
    if (a > at + 1e-9) spans.push({ start: at, bars: Math.max(1, Math.round((a - at) / BEATS_PER_BAR)) });
    spans.push({ start: a, bars: Math.max(1, Math.round((e - a) / BEATS_PER_BAR)), kind: s.kind });
    at = e;
  }
  if (to > at + 1e-9) spans.push({ start: at, bars: Math.max(1, Math.round((to - at) / BEATS_PER_BAR)) });
  return spans;
}
