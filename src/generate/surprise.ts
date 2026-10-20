// "Surprise me": an 8-bar loop in under a second, without AI. And the accompaniment for a hummed melody.
// Pure and deterministic for a seed.
import { chordPitchClasses, chordRoot, parseKey, progression, rng, type NoteSpec, type SongPlan } from './plan';

/** 12 well-worn progressions (4 chords, one per bar), in Roman numerals. */
export const PROGRESSIONS: { name: string; numerals: string[]; minor?: boolean }[] = [
  { name: 'Pop', numerals: ['I', 'V', 'vi', 'IV'] },
  { name: 'Fifties', numerals: ['I', 'vi', 'IV', 'V'] },
  { name: 'Sensitive', numerals: ['vi', 'IV', 'I', 'V'] },
  { name: 'Jazz turnaround', numerals: ['ii7', 'V7', 'Imaj7', 'vi7'] },
  { name: 'Canon', numerals: ['I', 'V', 'vi', 'iii'] },
  { name: 'Rock', numerals: ['I', 'bVII', 'IV', 'I'] },
  { name: 'Lo-fi', numerals: ['IVmaj7', 'iii7', 'ii7', 'Imaj7'] },
  { name: 'Andalusian', numerals: ['i', 'bVII', 'bVI', 'V'], minor: true },
  { name: 'Minor epic', numerals: ['i', 'bVI', 'bIII', 'bVII'], minor: true },
  { name: 'Minor pop', numerals: ['i', 'iv', 'bVII', 'bIII'], minor: true },
  { name: 'Dorian groove', numerals: ['i7', 'IV7', 'i7', 'IV7'], minor: true },
  { name: 'Soul', numerals: ['IVmaj7', 'iii7', 'vi7', 'Imaj7'] },
];

const MAJOR_KEYS = ['C', 'D', 'Eb', 'F', 'G', 'A', 'Bb'];
const MINOR_KEYS = ['Am', 'Dm', 'Em', 'Cm', 'Gm', 'Fm'];

/** 16-step drum grooves (x = hit, X = accent, o = ghost, - = rest). */
export const GROOVES: { name: string; kit: string; bpm: [number, number]; pattern: Record<string, string> }[] = [
  { name: 'Lo-fi', kit: 'kit-lofi', bpm: [72, 88], pattern: { kick: 'x-----x---x-----', snare: '----x-------x---', hihat: 'x-x-x-xox-x-x-xo' } },
  { name: 'Pop', kit: 'kit-studio', bpm: [96, 118], pattern: { kick: 'x-------x-x-----', snare: '----X-------X---', hihat: 'x-x-x-x-x-x-x-x-' } },
  { name: 'Trap', kit: 'kit-808', bpm: [130, 150], pattern: { kick: 'x------x--x-----', clap: '--------X-------', hihat: 'xxxxxxxxxxxxxxxx' } },
  { name: 'House', kit: 'kit-studio', bpm: [118, 126], pattern: { kick: 'x---x---x---x---', clap: '----x-------x---', openhat: '--x---x---x---x-', hihat: 'x-x-x-x-x-x-x-x-' } },
  { name: 'Funk', kit: 'kit-studio', bpm: [98, 110], pattern: { kick: 'x--x--x---x--x--', snare: '----X--o-o--X---', hihat: 'xoxoxoxoxoxoxoxo' } },
];

export interface Surprise {
  plan: SongPlan;
  /** What was picked, to show the user. */
  summary: { groove: string; progression: string; key: string; bpm: number; chords: string[] };
}

/** Bass line: the root on beat 1 and 3, a passing fifth or octave sometimes. */
function bassLine(chords: string[], r: ReturnType<typeof rng>): NoteSpec[] {
  return chords.flatMap((c, bar) => {
    const root = chordRoot(c, 2);
    const third = r.next() < 0.5 ? root + 7 : root + 12;
    return [
      { pitch: root, start: bar * 4, duration: 1.5, velocity: 0.85 },
      { pitch: root, start: bar * 4 + 2, duration: 1, velocity: 0.7 },
      { pitch: third, start: bar * 4 + 3, duration: 0.75, velocity: 0.6 },
    ];
  });
}

export function surprisePlan(seed: number): Surprise {
  const r = rng(seed);
  const prog = r.pick(PROGRESSIONS);
  const key = prog.minor ? r.pick(MINOR_KEYS) : r.pick(MAJOR_KEYS);
  const groove = r.pick(GROOVES);
  const bpm = r.int(groove.bpm[0], groove.bpm[1]);
  const chords = progression(prog.numerals, key);
  const eight = [...chords, ...chords];
  const keysInstrument = r.pick(['velvet-keys', 'felt-piano', 'aurora-pad']);
  const style = keysInstrument === 'aurora-pad' ? 'block' : r.pick(['block', 'stabs', 'arpeggio'] as const);
  const plan: SongPlan = {
    id: `surprise-${seed}`,
    name: `${groove.name} in ${key}`,
    bpm,
    key,
    tracks: [
      { name: 'Drums', instrument: groove.kit, kind: 'drums', parts: [{ type: 'drums', start_bar: 1, bars: 8, pattern: groove.pattern, name: groove.name }] },
      { name: 'Bass', instrument: r.pick(['finger-bass', 'sub-bass']), volume: 0.8, parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: bassLine(eight, r), name: 'Bass line' }] },
      { name: 'Keys', instrument: keysInstrument, volume: 0.7, reverb: 0.3, parts: [{ type: 'chords', start_bar: 1, chords: eight, style, octave: 3, velocity: 0.65, name: prog.name }] },
    ],
    loop: [1, 9],
  };
  return { plan, summary: { groove: groove.name, progression: prog.name, key, bpm, chords } };
}

/**
 * Chords for a melody, one per bar: the diatonic triad (I…vi) whose notes the melody spends the most
 * time on in that bar, with a bonus for the note on the downbeat. Ties prefer I, IV, V.
 */
export function harmonize(melody: { pitch: number; start: number; duration: number }[], key: string, bars: number): string[] {
  const { minor } = parseKey(key);
  const candidates = progression(minor ? ['i', 'iv', 'v', 'bVI', 'bIII', 'bVII'] : ['I', 'IV', 'V', 'vi', 'ii', 'iii'], key);
  const out: string[] = [];
  for (let b = 0; b < bars; b++) {
    const lo = b * 4;
    const hi = lo + 4;
    const scores = candidates.map((c, rank) => {
      const pcs = chordPitchClasses(c);
      let s = -rank * 0.01; // tie-break by order (I, IV, V first)
      for (const n of melody) {
        const overlap = Math.min(hi, n.start + n.duration) - Math.max(lo, n.start);
        if (overlap <= 0 || !pcs.includes(((n.pitch % 12) + 12) % 12)) continue;
        s += overlap + (n.start <= lo + 0.25 && n.start + n.duration > lo ? 1 : 0);
      }
      return s;
    });
    const best = scores.indexOf(Math.max(...scores));
    // A bar with no melody keeps the previous chord (or the tonic).
    out.push(scores[best] <= 0 ? (out[b - 1] ?? candidates[0]) : candidates[best]);
  }
  return out;
}

/** Accompaniment for a hummed melody: chords, bass and a soft beat under it. */
export function accompanimentPlan(melody: { pitch: number; start: number; duration: number }[], key: string, bpm: number, startBar: number): Omit<SongPlan, 'id' | 'name'> {
  const bars = Math.max(1, Math.ceil(Math.max(...melody.map((n) => n.start + n.duration)) / 4));
  const chords = harmonize(melody, key, bars);
  const r = rng(bars * 31 + melody.length);
  return {
    bpm,
    key,
    tracks: [
      { name: 'Chords', instrument: 'felt-piano', volume: 0.6, reverb: 0.3, parts: [{ type: 'chords', start_bar: startBar, chords, octave: 3, velocity: 0.55, name: 'Chords' }] },
      { name: 'Bass', instrument: 'finger-bass', volume: 0.75, parts: [{ type: 'notes', start_bar: startBar, length_bars: bars, notes: bassLine(chords, r), name: 'Bass line' }] },
      { name: 'Drums', instrument: 'kit-lofi', kind: 'drums', volume: 0.6, parts: [{ type: 'drums', start_bar: startBar, bars, pattern: GROOVES[0].pattern, name: 'Beat' }] },
    ],
  };
}
