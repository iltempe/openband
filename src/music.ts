// Music theory helpers shared by the UI and the AI command layer.

export const BEATS_PER_BAR = 4;

export const uid = (prefix = 'id') =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);

/** 60 -> "C4" */
export const noteName = (pitch: number) => `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;

/** Accepts MIDI numbers, note names ("C4", "F#3", "Bb2") and drum names ("kick"). */
export function parsePitch(value: number | string, drums = false): number {
  if (typeof value === 'number') return clamp(Math.round(value), 0, 127);
  const v = value.trim();
  if (/^\d+$/.test(v)) return clamp(parseInt(v, 10), 0, 127);
  if (drums) {
    const piece = findDrum(v);
    if (piece) return piece.pitch;
  }
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d)$/.exec(v);
  if (!m) {
    const piece = findDrum(v);
    if (piece) return piece.pitch;
    throw new Error(`Unrecognised pitch "${value}". Use MIDI numbers, note names like "C4", or drum names.`);
  }
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return clamp(LETTER[m[1].toUpperCase()] + acc + (parseInt(m[3], 10) + 1) * 12, 0, 127);
}

// ---------- Drums (General MIDI drum map subset) ----------

export interface DrumPiece {
  pitch: number;
  name: string;
  short: string;
  aliases: string[];
}

/** Listed top-to-bottom as shown in the step sequencer. */
export const DRUM_PIECES: DrumPiece[] = [
  { pitch: 49, name: 'Crash', short: 'CR', aliases: ['crash', 'cymbal'] },
  { pitch: 51, name: 'Ride', short: 'RD', aliases: ['ride'] },
  { pitch: 50, name: 'High tom', short: 'T1', aliases: ['hightom', 'high_tom', 'tom1', 'tom_high', 'tomalto'] },
  { pitch: 48, name: 'Mid tom', short: 'T2', aliases: ['midtom', 'mid_tom', 'tom2', 'tom_mid', 'tommedio'] },
  { pitch: 45, name: 'Low tom', short: 'T3', aliases: ['lowtom', 'low_tom', 'tom3', 'floortom', 'tom_low', 'tombasso'] },
  { pitch: 46, name: 'Open hi-hat', short: 'OH', aliases: ['openhat', 'open_hat', 'ohh', 'oh', 'hihat_open', 'hihataperto'] },
  { pitch: 42, name: 'Closed hi-hat', short: 'HH', aliases: ['hihat', 'hat', 'hh', 'chh', 'closedhat', 'closed_hat', 'hihat_closed', 'hihatchiuso'] },
  { pitch: 37, name: 'Rim', short: 'RM', aliases: ['rim', 'rimshot', 'sidestick'] },
  { pitch: 39, name: 'Clap', short: 'CP', aliases: ['clap', 'handclap'] },
  { pitch: 38, name: 'Snare', short: 'SN', aliases: ['snare', 'sd', 'rullante'] },
  { pitch: 36, name: 'Kick', short: 'KK', aliases: ['kick', 'bd', 'bassdrum', 'bass_drum', 'cassa'] },
];

export function findDrum(name: string): DrumPiece | undefined {
  const k = name.toLowerCase().replace(/[\s-]/g, '');
  return DRUM_PIECES.find((d) => d.aliases.includes(k) || d.name.toLowerCase().replace(/\s/g, '') === k);
}

export const drumByPitch = (pitch: number) => DRUM_PIECES.find((d) => d.pitch === pitch);

// ---------- Chords ----------

const CHORD_QUALITIES: [RegExp, number[]][] = [
  [/^(maj7|M7|Δ7?)$/, [0, 4, 7, 11]],
  [/^(m7|min7|-7)$/, [0, 3, 7, 10]],
  [/^(7|dom7)$/, [0, 4, 7, 10]],
  [/^(m9|min9)$/, [0, 3, 7, 10, 14]],
  [/^(maj9|M9)$/, [0, 4, 7, 11, 14]],
  [/^9$/, [0, 4, 7, 10, 14]],
  [/^(m7b5|ø7?)$/, [0, 3, 6, 10]],
  [/^(dim7|°7)$/, [0, 3, 6, 9]],
  [/^(dim|°)$/, [0, 3, 6]],
  [/^(aug|\+)$/, [0, 4, 8]],
  [/^sus2$/, [0, 2, 7]],
  [/^sus4?$/, [0, 5, 7]],
  [/^add9$/, [0, 4, 7, 14]],
  [/^(m|min|-)$/, [0, 3, 7]],
  [/^(maj|M)?$/, [0, 4, 7]],
  [/^6$/, [0, 4, 7, 9]],
  [/^m6$/, [0, 3, 7, 9]],
  [/^5$/, [0, 7]],
];

/** "Am7" -> MIDI pitches with the root in the given octave. Supports slash chords ("C/E"). */
export function parseChord(symbol: string, octave = 3): number[] {
  const [main, bass] = symbol.trim().split('/');
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(main);
  if (!m) throw new Error(`Unrecognised chord "${symbol}"`);
  const root = LETTER[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const quality = CHORD_QUALITIES.find(([re]) => re.test(m[3]));
  if (!quality) throw new Error(`Unrecognised chord quality "${m[3]}" in "${symbol}"`);
  const base = (octave + 1) * 12 + ((root + 12) % 12);
  const notes = quality[1].map((i) => base + i);
  if (bass) {
    const b = parsePitch(`${bass}${octave - 1}`);
    if (!notes.includes(b)) notes.unshift(b);
  }
  return notes;
}

export const KEYS = [
  'C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B',
  'Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm',
];

export const TRACK_COLORS = ['#34d399', '#60a5fa', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c', '#a3e635', '#f87171'];
export const DRUM_COLOR = '#fbbf24';
export const AUDIO_COLOR = '#e879f9';

/** Fader 0..1 -> decibels (0.8 = 0 dB). */
export const faderToDb = (v: number) => (v <= 0.001 ? -Infinity : 20 * Math.log10(v / 0.8));
/** Send 0..1 -> decibels. */
export const sendToDb = (v: number) => (v <= 0.001 ? -Infinity : 20 * Math.log10(v));
/** Smart-control tone 0..1 -> low-pass frequency (80 Hz .. 20 kHz). */
export const cutoffToHz = (v: number) => 80 * Math.pow(2, clamp(v, 0, 1) * 7.97);

/** Semitones from one key's root to another's, the short way (−6…+5): "Am" → "Cm" = 3. */
export function keyInterval(from: string, to: string): number {
  const pc = (k: string) => {
    const m = k.trim().match(/^([A-Ga-g])([#b♯♭]?)/);
    if (!m) return null;
    const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
    return (base + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0) + 12) % 12;
  };
  const a = pc(from);
  const b = pc(to);
  if (a === null || b === null) return 0;
  return ((b - a + 18) % 12) - 6;
}
