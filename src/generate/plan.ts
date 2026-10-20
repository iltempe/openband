// Songs as plans: what to build, described with the same vocabulary as the commands (bars, chord
// symbols, drum step strings). Pure — the app applies a plan with runCommand (generate/apply.ts).
import type { SectionKind } from '../types';

export interface NoteSpec {
  pitch: number | string;
  start: number;
  duration?: number;
  velocity?: number;
}

export type PartSpec =
  | { type: 'drums'; start_bar: number; bars: number; pattern: Record<string, string>; name?: string }
  | { type: 'chords'; start_bar: number; chords: string[]; beats_per_chord?: number; octave?: number; style?: 'block' | 'arpeggio' | 'stabs'; velocity?: number; name?: string }
  | { type: 'notes'; start_bar: number; length_bars: number; notes: NoteSpec[]; name?: string };

export interface TrackSpec {
  name: string;
  instrument: string;
  kind?: 'instrument' | 'drums';
  volume?: number;
  pan?: number;
  reverb?: number;
  parts: PartSpec[];
}

export interface SongPlan {
  id: string;
  name: string;
  bpm: number;
  key: string;
  tracks: TrackSpec[];
  sections?: { name: string; kind: SectionKind; start_bar: number; length_bars: number }[];
  /** Lyrics per section (index into sections). */
  lyrics?: { section: number; text: string; language?: 'en' | 'it' }[];
  /** Explanations (F14): on a section (by index) or on the first part of a track (by index). */
  notes?: { on: { section: number } | { track: number }; text: string }[];
  /** Cycle, in bars [start, end) (end exclusive). */
  loop?: [number, number];
}

// ---------------------------------------------------------------- harmony

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PC: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export function parseKey(key: string): { tonic: number; minor: boolean; flats: boolean } {
  const m = key.trim().match(/^([A-G][#b]?)(m|min|minor)?$/i);
  if (!m) throw new Error(`Unknown key "${key}"`);
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return { tonic: PC[name], minor: !!m[2], flats: FLAT_KEYS.has(key.trim()) };
}

/**
 * A Roman numeral in a key → chord symbol. Uppercase = major, lowercase = minor; "b" lowers the root
 * (bVII, bVI); suffixes 7, maj7, sus4, dim are kept. Plain numerals follow the key's own scale (natural
 * minor in minor keys, so "V" there is the major dominant, "v" the minor one); numerals with b/# are
 * relative to the major scale, as usual (bVII is G in both C and Cm… and in Am it is G too).
 */
export function romanToChord(numeral: string, key: string): string {
  const { tonic, minor, flats } = parseKey(key);
  const m = numeral.match(/^(b|#)?([ivIV]+)(.*)$/);
  if (!m) throw new Error(`Unknown numeral "${numeral}"`);
  const deg = ROMAN.indexOf(m[2].toUpperCase());
  if (deg < 0) throw new Error(`Unknown numeral "${numeral}"`);
  const shift = m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0;
  const scale = minor && !shift ? MINOR : MAJOR;
  const root = (tonic + scale[deg] + shift + 12) % 12;
  const isMinor = m[2] === m[2].toLowerCase();
  const suffix = m[3];
  const quality = suffix === 'dim' ? 'dim' : isMinor ? 'm' : '';
  const ext = suffix === 'dim' ? '' : suffix;
  return `${(flats || shift < 0 ? FLATS : SHARPS)[root]}${quality}${ext}`;
}

export const progression = (numerals: string[], key: string) => numerals.map((n) => romanToChord(n, key));

/** Root of a chord symbol as a MIDI pitch in the given octave (C3 = 48). */
export function chordRoot(symbol: string, octave = 2): number {
  const m = symbol.match(/^([A-G][#b]?)/);
  if (!m) throw new Error(`Unknown chord "${symbol}"`);
  return (octave + 1) * 12 + PC[m[1]];
}

/** Pitch classes of a triad chord symbol (enough for harmonising a melody). */
export function chordPitchClasses(symbol: string): number[] {
  const root = chordRoot(symbol, 0) % 12;
  const rest = symbol.replace(/^[A-G][#b]?/, '');
  const third = rest.startsWith('m') && !rest.startsWith('maj') ? 3 : rest.startsWith('dim') ? 3 : rest.startsWith('sus') ? 5 : 4;
  const fifth = rest.startsWith('dim') ? 6 : 7;
  return [root, (root + third) % 12, (root + fifth) % 12];
}

// ---------------------------------------------------------------- randomness

/** Small deterministic generator (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)], int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}
