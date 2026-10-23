// The little music theory OMEP tools need: keys, scales, chords and note names. No dependencies.

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** "Dm" → { tonic: 2, minor: true }; null when it is not a key. */
export function parseKey(key) {
  const m = /^([A-G])(#|b)?(m)?$/.exec(String(key ?? '').trim());
  if (!m) return null;
  return { tonic: (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12, minor: !!m[3] };
}
export const keyName = (k) => `${NOTE_NAMES[k.tonic]}${k.minor ? 'm' : ''}`;

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
/** Pitch classes of a key's scale (natural minor; the leading tone counts as in key in minor). */
export function scalePcs(key) {
  const k = typeof key === 'string' ? parseKey(key) : key;
  const steps = k.minor ? [...MINOR, 11] : MAJOR;
  return new Set(steps.map((s) => (k.tonic + s) % 12));
}

/** 1 same key, 0.5 relative or parallel key, 0.25 a fifth away, 0 otherwise. */
export function keySimilarity(a, b) {
  const x = typeof a === 'string' ? parseKey(a) : a;
  const y = typeof b === 'string' ? parseKey(b) : b;
  if (!x || !y) return 0;
  if (x.tonic === y.tonic && x.minor === y.minor) return 1;
  const rel = (k) => (k.minor ? { tonic: (k.tonic + 3) % 12, minor: false } : { tonic: (k.tonic + 9) % 12, minor: true });
  const r = rel(x);
  if ((r.tonic === y.tonic && r.minor === y.minor) || x.tonic === y.tonic) return 0.5;
  const d = (y.tonic - x.tonic + 12) % 12;
  if (x.minor === y.minor && (d === 7 || d === 5)) return 0.25;
  return 0;
}

const QUALITY = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], dim: [0, 3, 6], sus4: [0, 5, 7], sus2: [0, 2, 7], m9: [0, 3, 7, 10, 14], 9: [0, 4, 7, 10, 14] };
/** "Dm7" → { root: 2, tones: [2, 5, 9, 0] } (pitch classes); null for unknown symbols. */
export function parseChord(sym) {
  const m = /^([A-G])(#|b)?(maj7|m7|m9|m|7|9|dim|sus4|sus2)?$/.exec(String(sym ?? '').trim());
  if (!m) return null;
  const root = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { root, tones: (QUALITY[m[3] ?? ''] ?? QUALITY['']).map((i) => (root + i) % 12) };
}

/** "E2" → 40, null when malformed. */
export function noteNumber(name) {
  const m = /^([A-G])(#|b)?(-?[0-9])$/.exec(String(name));
  if (!m) return null;
  return (Number(m[3]) + 1) * 12 + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

/** Beats per bar of a meter such as "4/4" or "6/8" (in quarter notes). */
export function beatsPerBar(meter = '4/4') {
  const [n, d] = String(meter).split('/').map(Number);
  return (n * 4) / d;
}
