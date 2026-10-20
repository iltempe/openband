// Eight small starting songs, each explained by annotations (so "teach me" is also the tutorial).
// Plans only: applied with the same commands the AI uses.
import { progression, type NoteSpec, type SongPlan } from '../generate/plan';

const rep = <T,>(xs: T[], n: number) => Array.from({ length: n }, () => xs).flat();
const mel = (bar0: number, notes: [string, number, number?][]): NoteSpec[] => notes.map(([pitch, start, duration = 1]) => ({ pitch, start: (bar0 - 1) * 4 + start, duration }));

export interface Template {
  id: string;
  emoji: string;
  /** i18n keys: tpl.<id> and tpl.<id>.sub */
  plan: SongPlan;
}

const lofi: SongPlan = {
  id: 'lofi',
  name: 'Lo-fi study beat',
  bpm: 80,
  key: 'F',
  tracks: [
    { name: 'Drums', instrument: 'kit-lofi', kind: 'drums', parts: [{ type: 'drums', start_bar: 1, bars: 8, pattern: { kick: 'x-----x---x-----', snare: '----x-------x---', hihat: 'x-x-x-xox-x-x-xo' } }] },
    { name: 'Keys', instrument: 'velvet-keys', reverb: 0.35, parts: [{ type: 'chords', start_bar: 1, chords: rep(progression(['IVmaj7', 'iii7', 'ii7', 'Imaj7'], 'F'), 2), octave: 3, velocity: 0.6 }] },
    { name: 'Bass', instrument: 'finger-bass', parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: rep(['Bb1', 'A1', 'G1', 'F1'], 2).map((p, i) => ({ pitch: p, start: i * 4, duration: 3, velocity: 0.8 })) }] },
  ],
  sections: [
    { name: 'Loop A', kind: 'verse', start_bar: 1, length_bars: 4 },
    { name: 'Loop B', kind: 'chorus', start_bar: 5, length_bars: 4 },
  ],
  notes: [
    { on: { track: 1 }, text: 'Every chord is a **seventh** (maj7, m7): the extra note softens the harmony — the lo-fi sound is half chords, half dusty drums.' },
    { on: { track: 0 }, text: 'The kick is late on the *and of 2* and the hi-hat has ghost notes (o): that lazy swing is the genre.' },
  ],
  loop: [1, 9],
};

const ballad: SongPlan = {
  id: 'ballad',
  name: 'Pop ballad',
  bpm: 72,
  key: 'C',
  tracks: [
    { name: 'Piano', instrument: 'felt-piano', reverb: 0.35, parts: [
      { type: 'chords', start_bar: 1, chords: progression(['I', 'V', 'vi', 'IV'], 'C'), style: 'arpeggio', octave: 3, velocity: 0.55, name: 'Verse' },
      { type: 'chords', start_bar: 5, chords: progression(['vi', 'IV', 'I', 'V'], 'C'), octave: 3, velocity: 0.7, name: 'Chorus' },
    ] },
    { name: 'Strings', instrument: 'silk-strings', volume: 0.55, parts: [{ type: 'chords', start_bar: 5, chords: progression(['vi', 'IV', 'I', 'V'], 'C'), octave: 4, velocity: 0.5 }] },
    { name: 'Melody', instrument: 'neon-lead', volume: 0.6, parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: [
      ...mel(1, [['E4', 0], ['G4', 1], ['G4', 2, 2], ['D4', 4], ['E4', 5], ['G4', 6, 2], ['C5', 8, 2], ['B4', 10], ['A4', 11], ['A4', 12, 4]]),
      ...mel(5, [['A4', 0], ['C5', 1, 2], ['A4', 3], ['C5', 4], ['E5', 5, 3], ['G4', 8], ['E5', 9, 2], ['D5', 11], ['D5', 12, 4]]),
    ] }] },
  ],
  sections: [
    { name: 'Verse', kind: 'verse', start_bar: 1, length_bars: 4 },
    { name: 'Chorus', kind: 'chorus', start_bar: 5, length_bars: 4 },
  ],
  lyrics: [
    { section: 0, text: 'Write your first line here\nand the answer here' },
    { section: 1, text: 'This is where the chorus goes\nsing it loud and slow' },
  ],
  notes: [
    { on: { section: 0 }, text: 'The verse uses **I–V–vi–IV**, the most common pop loop: it feels like home and keeps moving.' },
    { on: { section: 1 }, text: 'The chorus starts on **vi** (Am) instead: same four chords, new starting point — instant contrast. Strings enter to lift it.' },
  ],
  loop: [1, 9],
};

const trap: SongPlan = {
  id: 'trap',
  name: 'Trap',
  bpm: 140,
  key: 'Cm',
  tracks: [
    { name: '808 kit', instrument: 'kit-808', kind: 'drums', parts: [{ type: 'drums', start_bar: 1, bars: 8, pattern: { kick: 'x------x--x-----', clap: '--------X-------', hihat: 'xxxxxxxxxxxxx-x-', openhat: '-------------x--' } }] },
    { name: '808 bass', instrument: 'sub-bass', parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: rep([['C2', 0, 1.5], ['C2', 1.75, 0.75], ['Eb2', 2.5, 1.5]] as [string, number, number][], 8).map(([p, s, d], i) => ({ pitch: p, start: Math.floor(i / 3) * 4 + s, duration: d })) }] },
    { name: 'Bells', instrument: 'crystal-bells', volume: 0.55, reverb: 0.4, parts: [{ type: 'chords', start_bar: 1, chords: rep(progression(['i', 'bVI', 'bIII', 'bVII'], 'Cm'), 2), style: 'arpeggio', octave: 4, velocity: 0.5 }] },
  ],
  sections: [{ name: 'Hook', kind: 'chorus', start_bar: 1, length_bars: 8 }],
  notes: [
    { on: { track: 0 }, text: 'Half-time feel: the clap only on beat 3 makes 140 BPM feel like 70. The **rolling hi-hats** carry the speed.' },
    { on: { track: 1 }, text: 'The 808 follows the kick: bass and kick hit together so the low end sounds like one instrument.' },
  ],
  loop: [1, 9],
};

const house: SongPlan = {
  id: 'house',
  name: 'House',
  bpm: 124,
  key: 'Am',
  tracks: [
    { name: 'Drums', instrument: 'kit-studio', kind: 'drums', parts: [{ type: 'drums', start_bar: 1, bars: 8, pattern: { kick: 'x---x---x---x---', clap: '----x-------x---', openhat: '--x---x---x---x-', hihat: 'xxxxxxxxxxxxxxxx' } }] },
    { name: 'Stabs', instrument: 'retro-organ', volume: 0.6, parts: [{ type: 'chords', start_bar: 1, chords: rep(progression(['i7', 'iv7', 'bVII', 'bIII'], 'Am'), 2), style: 'stabs', octave: 3, velocity: 0.65 }] },
    { name: 'Bass', instrument: 'acid-bass', volume: 0.7, parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: Array.from({ length: 32 }, (_, i) => ({ pitch: ['A1', 'D2', 'G1', 'C2'][Math.floor(i / 4) % 4], start: i + 0.5, duration: 0.4, velocity: 0.8 })) }] },
  ],
  sections: [{ name: 'Groove', kind: 'verse', start_bar: 1, length_bars: 8 }],
  notes: [
    { on: { track: 0 }, text: '**Four on the floor**: a kick on every beat, the open hat on the off-beats — the push-pull of house.' },
    { on: { track: 2 }, text: 'The bass plays only **off-beats** (start x.5), so it never fights the kick.' },
  ],
  loop: [1, 9],
};

const rock: SongPlan = {
  id: 'rock',
  name: 'Rock',
  bpm: 120,
  key: 'E',
  tracks: [
    { name: 'Drums', instrument: 'kit-studio', kind: 'drums', parts: [{ type: 'drums', start_bar: 1, bars: 8, pattern: { kick: 'x-----x-x-------', snare: '----X-------X---', hihat: 'x-x-x-x-x-x-x-x-', crash: 'x---------------' } }] },
    { name: 'Guitar', instrument: 'chip', volume: 0.6, parts: [{ type: 'chords', start_bar: 1, chords: rep(progression(['I', 'bVII', 'IV', 'I'], 'E'), 2), style: 'stabs', octave: 3, velocity: 0.8 }] },
    { name: 'Bass', instrument: 'finger-bass', parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: rep(['E1', 'D2', 'A1', 'E1'], 2).flatMap((p, bar) => Array.from({ length: 8 }, (_, k) => ({ pitch: p, start: bar * 4 + k * 0.5, duration: 0.45, velocity: k % 2 ? 0.65 : 0.85 }))) }] },
  ],
  sections: [
    { name: 'Riff', kind: 'intro', start_bar: 1, length_bars: 4 },
    { name: 'Verse', kind: 'verse', start_bar: 5, length_bars: 4 },
  ],
  notes: [
    { on: { section: 0 }, text: '**I–bVII–IV**: the bVII (D in E) is borrowed from the minor key — the classic rock move, think Hey Jude or Sweet Child.' },
    { on: { track: 2 }, text: 'Straight eighth notes on the root: the bass is the engine, accents on the beats.' },
  ],
  loop: [1, 9],
};

const bossa: SongPlan = {
  id: 'bossa',
  name: 'Bossa nova',
  bpm: 128,
  key: 'D',
  tracks: [
    { name: 'Percussion', instrument: 'kit-studio', kind: 'drums', volume: 0.6, parts: [{ type: 'drums', start_bar: 1, bars: 8, pattern: { kick: 'x--x----x--x----', rim: 'x--x--x---x--x--', hihat: 'xxxxxxxxxxxxxxxx' } }] },
    { name: 'Guitar', instrument: 'pluck', parts: [{ type: 'chords', start_bar: 1, chords: rep(progression(['Imaj7', 'ii7', 'V7', 'Imaj7'], 'D'), 2), style: 'stabs', octave: 3, velocity: 0.55 }] },
    { name: 'Bass', instrument: 'finger-bass', volume: 0.7, parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: rep(['D2', 'E2', 'A1', 'D2'], 2).flatMap((p, bar) => [{ pitch: p, start: bar * 4, duration: 1.4 }, { pitch: p, start: bar * 4 + 1.5, duration: 0.5 }, { pitch: p, start: bar * 4 + 2, duration: 1.4 }, { pitch: p, start: bar * 4 + 3.5, duration: 0.5 }]) }] },
  ],
  sections: [{ name: 'A', kind: 'verse', start_bar: 1, length_bars: 8 }],
  notes: [
    { on: { track: 0 }, text: 'The **rim clave** (3-3-4-3-3) is the bossa signature: the guitar and the rim talk to each other across the bar.' },
    { on: { track: 1 }, text: '**ii7–V7–Imaj7**, the jazz cadence, with sevenths everywhere: bossa is jazz harmony on a samba rhythm.' },
  ],
  loop: [1, 9],
};

const songwriter: SongPlan = {
  id: 'songwriter',
  name: 'Singer-songwriter',
  bpm: 92,
  key: 'G',
  tracks: [
    { name: 'Guitar', instrument: 'pluck', parts: [{ type: 'chords', start_bar: 1, chords: rep(progression(['I', 'vi', 'IV', 'V'], 'G'), 2), style: 'arpeggio', octave: 3, velocity: 0.6 }] },
    { name: 'Voice', instrument: 'neon-lead', volume: 0.6, parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: [
      ...mel(1, [['D4', 0.5, 0.5], ['D4', 1], ['B3', 2, 2], ['E4', 4.5, 0.5], ['E4', 5], ['C4', 6, 2], ['C4', 8.5, 0.5], ['D4', 9], ['E4', 10, 2], ['D4', 12, 4]]),
      ...mel(5, [['G4', 0, 2], ['E4', 2, 2], ['C4', 4, 2], ['E4', 6, 2], ['D4', 8, 2], ['B3', 10, 2], ['A3', 12, 4]]),
    ] }] },
  ],
  sections: [
    { name: 'Verse', kind: 'verse', start_bar: 1, length_bars: 4 },
    { name: 'Chorus', kind: 'chorus', start_bar: 5, length_bars: 4 },
  ],
  lyrics: [
    { section: 0, text: 'Here goes a line about a place\nhere goes a line about a face' },
    { section: 1, text: 'And this is what I want to say\nsing it back to me some day' },
  ],
  notes: [
    { on: { section: 0 }, text: 'Guitar and voice only: the verse melody **starts on the off-beat** (0.5), like speech. Replace the lyrics and press *Align* in the Lyrics panel.' },
    { on: { section: 1 }, text: 'The chorus melody jumps **up to G4** and uses long notes: higher and longer = the part people remember.' },
  ],
  loop: [1, 9],
};

const ambient: SongPlan = {
  id: 'ambient',
  name: 'Ambient soundtrack',
  bpm: 70,
  key: 'Dm',
  tracks: [
    { name: 'Pad', instrument: 'aurora-pad', reverb: 0.6, parts: [{ type: 'chords', start_bar: 1, chords: progression(['i', 'bVI', 'bIII', 'bVII'], 'Dm'), beats_per_chord: 8, octave: 3, velocity: 0.5 }] },
    { name: 'Strings', instrument: 'silk-strings', volume: 0.5, reverb: 0.5, parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: [{ pitch: 'A4', start: 0, duration: 8 }, { pitch: 'C5', start: 8, duration: 8 }, { pitch: 'G4', start: 16, duration: 8 }, { pitch: 'A4', start: 24, duration: 8 }] }] },
    { name: 'Bells', instrument: 'crystal-bells', volume: 0.4, reverb: 0.7, parts: [{ type: 'notes', start_bar: 1, length_bars: 8, notes: [0, 3, 7, 10, 16, 19, 23, 26].map((s, i) => ({ pitch: ['D5', 'F5', 'A5', 'E5'][i % 4], start: s, duration: 2, velocity: 0.45 })) }] },
  ],
  sections: [{ name: 'Scene', kind: 'intro', start_bar: 1, length_bars: 8 }],
  notes: [
    { on: { track: 0 }, text: 'Chords change every **two bars**: slow harmony is what makes music feel like a landscape.' },
    { on: { track: 1 }, text: 'One long string note over each chord — the melody is barely there; reverb does the rest.' },
  ],
  loop: [1, 9],
};

export const TEMPLATES: Template[] = [
  { id: 'lofi', emoji: '☕', plan: lofi },
  { id: 'ballad', emoji: '🎹', plan: ballad },
  { id: 'trap', emoji: '🔥', plan: trap },
  { id: 'house', emoji: '🪩', plan: house },
  { id: 'rock', emoji: '🎸', plan: rock },
  { id: 'bossa', emoji: '🌴', plan: bossa },
  { id: 'songwriter', emoji: '🎤', plan: songwriter },
  { id: 'ambient', emoji: '🌌', plan: ambient },
];
