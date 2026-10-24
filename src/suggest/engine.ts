// Ghost notes (G3): OpenBand's musical autocomplete. Local, instant and without an LLM: harmonic rules
// (chord tones on the strong beats, scale tones on the weak ones) and light statistical models — variable-
// order Markov chains over (interval, duration) for melodies and over scale degrees for chords — trained
// on the song itself first (so ideas stay coherent), then on a small bundled CC0 corpus. Motifs are
// repeated with variation. Every suggestion comes with the reasons for it. Pure: no network, no DOM.
import type { Note, Project, Region, Track } from '../types';
import { analyzeChords, parseKey, type ChordAt, type HNote } from '../analysis/harmony';
import { BEATS_PER_BAR } from '../music';
import { MELODIES, PROGRESSIONS, parseMelody } from './corpus';
import { Ppm, rng, sample } from './ppm';

export type SuggestKind = 'continue' | 'bass' | 'harmonize' | 'counter' | 'variation' | 'drum_fill';

export interface GhostNote {
  pitch: number;
  /** Beats, relative to the region's start. */
  start: number;
  duration: number;
  velocity: number;
}

export interface Suggestion {
  kind: SuggestKind;
  notes: GhostNote[];
  score: number;
  /** Why: short sentences ("chord tones of Am on the strong beats", "repeats the rhythm of bar 2"). */
  reasons: string[];
  /** Harmonize: the chord names, one per bar. */
  chords?: string[];
  /** Harmonize: these notes belong on a harmony track, not in this region. */
  newTrack?: boolean;
}

export interface SuggestOptions {
  kind?: SuggestKind;
  count?: number;
  seed?: number;
  /** Harmonize/counter: only these notes of the region (a selection). */
  noteIds?: string[];
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const QUALITY: Record<string, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], add9: [0, 2, 4, 7], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
};
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const mod = (a: number, n: number) => ((a % n) + n) % n;
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

// ---------------------------------------------------------------- the key and its scale

export interface Scale {
  tonic: number;
  minor: boolean;
  steps: number[];
}
export function scaleOf(key: string): Scale {
  const { tonic, minor } = parseKey(key || 'C');
  return { tonic, minor, steps: minor ? MINOR : MAJOR };
}
/** Pitch → index in the scale (0 = tonic of octave −1…); chromatic notes snap down. */
export function stepOf(pitch: number, s: Scale): number {
  const rel = pitch - s.tonic;
  const oct = Math.floor(rel / 12);
  const pc = mod(rel, 12);
  let i = 0;
  for (let k = 0; k < 7; k++) if (s.steps[k] <= pc) i = k;
  return oct * 7 + i;
}
export const pitchOf = (step: number, s: Scale) => s.tonic + Math.floor(step / 7) * 12 + s.steps[mod(step, 7)];
export const inScale = (pitch: number, s: Scale) => s.steps.includes(mod(pitch - s.tonic, 12));

// ---------------------------------------------------------------- the context of a region

export interface Context {
  project: Project;
  region: Region;
  track: Track;
  scale: Scale;
  /** Chords under the song, in song beats (from the other tracks; else from the region itself). */
  chords: ChordAt[];
  role: 'drums' | 'bass' | 'melody';
}

const songNotes = (p: Project, filter: (t: Track) => boolean): HNote[] =>
  p.regions.flatMap((r) => {
    const t = p.tracks.find((x) => x.id === r.trackId);
    return t && t.kind !== 'drums' && t.kind !== 'audio' && filter(t) ? r.notes.map((n) => ({ pitch: n.pitch, start: r.start + n.start, duration: n.duration, velocity: n.velocity })) : [];
  });

function roleOf(t: Track): Context['role'] {
  if (t.kind === 'drums' || t.role === 'drums' || t.role === 'kick') return 'drums';
  if (t.role === 'bass' || /bass|basso/i.test(`${t.name} ${t.instrument}`)) return 'bass';
  return 'melody';
}

export function contextOf(p: Project, regionId: string): Context {
  const region = p.regions.find((r) => r.id === regionId);
  if (!region) throw new Error(`Region "${regionId}" not found`);
  const track = p.tracks.find((t) => t.id === region.trackId)!;
  const scale = scaleOf(p.key);
  const from = 0;
  const to = Math.max(...p.regions.map((r) => r.start + r.length), region.start + region.length) + BEATS_PER_BAR * 2;
  let chords = analyzeChords(songNotes(p, (t) => t.id !== track.id), p.key, from, to);
  if (!chords.length) chords = analyzeChords(songNotes(p, () => true), p.key, from, to);
  return { project: p, region, track, scale, chords, role: roleOf(track) };
}

export function chordAt(ctx: Context, songBeat: number): ChordAt | null {
  return ctx.chords.find((c) => songBeat >= c.start - 1e-6 && songBeat < c.start + c.length - 1e-6) ?? null;
}
export function chordPcs(c: { root: number; quality: string }): number[] {
  return (QUALITY[c.quality] ?? QUALITY['']).map((i) => mod(c.root + i, 12));
}
/** Strong beats: 1 and 3 of the bar. */
const strong = (songBeat: number) => Math.abs(mod(songBeat, 2)) < 1e-6;

/** The region's line, one note per onset (the top one): what melody models read. */
function monophonic(notes: Note[] | GhostNote[]): GhostNote[] {
  const byStart = new Map<number, GhostNote>();
  for (const n of notes) {
    const k = Math.round(n.start * 1000);
    const o = byStart.get(k);
    if (!o || n.pitch > o.pitch) byStart.set(k, { pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity });
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- the models

/** Melody tokens: "interval in scale steps : duration in sixteenths" ("r:dur" for a rest before). */
function melodyTokens(line: GhostNote[], s: Scale): string[] {
  const out: string[] = [];
  let prev: GhostNote | null = null;
  for (const n of line) {
    if (prev) {
      const gap = Math.round((n.start - (prev.start + prev.duration)) * 4);
      if (gap > 0) out.push(`r:${Math.min(16, gap)}`);
      out.push(`${Math.max(-7, Math.min(7, stepOf(n.pitch, s) - stepOf(prev.pitch, s)))}:${Math.max(1, Math.min(16, Math.round(n.duration * 4)))}`);
    } else out.push(`0:${Math.max(1, Math.min(16, Math.round(n.duration * 4)))}`);
    prev = n;
  }
  return out;
}

/** The corpus melodies as tokens, and the chord model (built once). */
let corpusSeqs: string[][] | null = null;
let corpusChords: Ppm | null = null;
function corpus() {
  if (!corpusSeqs) {
    corpusSeqs = MELODIES.map((m) => {
      const seq: string[] = [];
      let prev: number | null = null;
      for (const { step, dur } of parseMelody(m)) {
        if (step === null) seq.push(`r:${dur}`);
        else {
          seq.push(`${prev === null ? 0 : step - prev}:${dur}`);
          prev = step;
        }
      }
      return seq;
    });
    corpusChords = new Ppm(2);
    for (const p of PROGRESSIONS) corpusChords.train(p.split(' '), 1);
  }
  return { melodies: corpusSeqs, chords: corpusChords! };
}

/** The melody model for a song: the corpus, then the song's own melodic lines weighted ×5. */
function melodyModel(ctx: Context): Ppm {
  const m = new Ppm(3);
  for (const seq of corpus().melodies) m.train(seq, 1);
  for (const r of ctx.project.regions) {
    const t = ctx.project.tracks.find((x) => x.id === r.trackId);
    if (!t || roleOf(t) !== 'melody' || r.notes.length < 3) continue;
    m.train(melodyTokens(monophonic(r.notes), ctx.scale), 5);
  }
  return m;
}

// ---------------------------------------------------------------- ranking

interface Candidate {
  notes: GhostNote[];
  logp: number;
  reasons: Set<string>;
}

function chordName(c: ChordAt | null) {
  return c ? c.chord : '';
}

/** Harmony + range + variety, added to the model's probability. Higher is better. */
function rank(ctx: Context, c: Candidate, context: GhostNote[]): number {
  const base = ctx.region.start;
  let strongN = 0;
  let strongIn = 0;
  for (const n of c.notes) {
    const ch = chordAt(ctx, base + n.start);
    if (!strong(base + n.start) || !ch) continue;
    strongN++;
    if (chordPcs(ch).includes(mod(n.pitch, 12))) strongIn++;
  }
  const harmony = strongN ? strongIn / strongN : 0.5;
  const all = [...context, ...c.notes];
  const pitches = all.map((n) => n.pitch);
  const span = Math.max(...pitches) - Math.min(...pitches);
  let leaps = 0;
  for (let i = 1; i < all.length; i++) if (Math.abs(all[i].pitch - all[i - 1].pitch) > 7) leaps++;
  const range = (ctx.role === 'melody' && span > 18 ? -(span - 18) * 0.3 : 0) - leaps * 0.6;
  const scaleOut = c.notes.filter((n) => !inScale(n.pitch, ctx.scale)).length * 0.5;
  return round4(c.logp / Math.max(1, c.notes.length) + harmony * 3 + range - scaleOut);
}

function distinct(cands: (Candidate & { score: number })[], count: number) {
  const seen = new Set<string>();
  const out: (Candidate & { score: number })[] = [];
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    const sig = c.notes.map((n) => `${n.pitch}@${n.start}`).join(',');
    if (!c.notes.length || seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

/** The nearest pitch to `near` whose pitch class is in `pcs`. */
function nearestIn(near: number, pcs: number[]): number {
  let best = near;
  let bd = Infinity;
  for (let d = -6; d <= 6; d++) {
    if (pcs.includes(mod(near + d, 12)) && Math.abs(d) < bd) {
      bd = Math.abs(d);
      best = near + d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- continue a melody

function continueMelody(ctx: Context, o: Required<Pick<SuggestOptions, 'count' | 'seed'>>): Suggestion[] {
  const line = monophonic(ctx.region.notes);
  if (!line.length) return [];
  const model = melodyModel(ctx);
  const s = ctx.scale;
  const base = ctx.region.start;
  const end = Math.max(...line.map((n) => n.start + n.duration));
  const barEnd = Math.ceil(end / BEATS_PER_BAR - 1e-6) * BEATS_PER_BAR;
  const target = barEnd + BEATS_PER_BAR;
  const history0 = melodyTokens(line, s);
  const lo = Math.min(...line.map((n) => n.pitch)) - 5;
  const hi = Math.max(...line.map((n) => n.pitch)) + 5;
  const vel = line[line.length - 1].velocity;
  // A motif to repeat: the rhythm of the last complete bar.
  const lastBar = Math.floor(end / BEATS_PER_BAR - 1e-6) - (end % BEATS_PER_BAR < 1e-6 ? 0 : 1);
  const motif = line.filter((n) => Math.floor(n.start / BEATS_PER_BAR) === lastBar).map((n) => ({ off: n.start - lastBar * BEATS_PER_BAR, dur: n.duration }));
  const cands: (Candidate & { score: number })[] = [];
  for (let k = 0; k < 24; k++) {
    const rand = rng(o.seed * 7919 + k * 104729 + 1);
    const notes: GhostNote[] = [];
    const reasons = new Set<string>();
    const history = [...history0];
    let pos = end;
    let prev = line[line.length - 1];
    let logp = 0;
    // Half the candidates repeat the last bar's rhythm in the next bar (repetition with variation).
    const useMotif = motif.length > 1 && k % 2 === 0;
    let guard = 0;
    while (pos < target - 1e-6 && guard++ < 64) {
      let dur: number;
      let interval: number | null;
      const dist = model.predict(history);
      if (useMotif && pos >= barEnd - 1e-6) {
        const inBar = pos - barEnd;
        const m = motif.find((x) => Math.abs(x.off - inBar) < 1e-6) ?? motif.find((x) => x.off > inBar);
        if (!m) break;
        if (m.off > inBar + 1e-6) {
          pos = barEnd + m.off;
          continue;
        }
        dur = m.dur;
        const pitched = new Map([...dist].filter(([t]) => !t.startsWith('r') && Number(t.split(':')[1]) === Math.round(dur * 4)));
        const tok = sample(pitched.size ? pitched : new Map([...dist].filter(([t]) => !t.startsWith('r'))), rand, 0.9) ?? '1:4';
        interval = Number(tok.split(':')[0]);
        logp += Math.log(dist.get(tok) ?? 1e-4);
        reasons.add(`repeats the rhythm of bar ${lastBar + 1}`);
      } else {
        const fits = new Map([...dist].filter(([t]) => pos + Number(t.split(':')[1]) / 4 <= target + 1e-6));
        const tok = sample(fits.size ? fits : dist, rand, 0.9) ?? '1:4';
        logp += Math.log(dist.get(tok) ?? 1e-4);
        const [a, b] = tok.split(':');
        dur = Math.min(Number(b) / 4, target - pos);
        if (a === 'r') {
          history.push(tok);
          pos += dur;
          continue;
        }
        interval = Number(a);
      }
      let pitch = pitchOf(stepOf(prev.pitch, s) + (interval ?? 0), s);
      const ch = chordAt(ctx, base + pos);
      if (strong(base + pos) && ch) {
        pitch = nearestIn(pitch, chordPcs(ch));
        reasons.add(`chord tones of ${chordName(ch)} on the strong beats`);
      } else if (!inScale(pitch, s)) pitch = nearestIn(pitch, s.steps.map((x) => mod(x + s.tonic, 12)));
      while (pitch > hi) pitch -= 12;
      while (pitch < lo) pitch += 12;
      if (Math.abs(pitch - prev.pitch) > 9) pitch += pitch > prev.pitch ? -12 : 12;
      const n = { pitch, start: round4(pos), duration: round4(Math.max(0.25, dur)), velocity: vel };
      notes.push(n);
      history.push(`${stepOf(pitch, s) - stepOf(prev.pitch, s)}:${Math.round(dur * 4)}`);
      prev = n;
      pos += dur;
    }
    // End on a chord tone of the bar's chord (a resting point).
    const last = notes[notes.length - 1];
    const ch = last ? chordAt(ctx, base + last.start) : null;
    if (last && ch && !chordPcs(ch).includes(mod(last.pitch, 12))) last.pitch = nearestIn(last.pitch, chordPcs(ch));
    const c: Candidate = { notes, logp, reasons };
    cands.push({ ...c, score: rank(ctx, c, line) });
  }
  return distinct(cands, o.count).map((c) => ({ kind: 'continue', notes: c.notes, score: c.score, reasons: [...c.reasons, ...(ctx.role === 'melody' ? ['stays in a singable range'] : [])] }));
}

// ---------------------------------------------------------------- a bass line under the chords

function bassLine(ctx: Context, o: Required<Pick<SuggestOptions, 'count' | 'seed'>>): Suggestion[] {
  const base = ctx.region.start;
  const len = ctx.region.length;
  const chords = ctx.chords.filter((c) => c.start + c.length > base && c.start < base + len);
  if (!chords.length) return [];
  const low = (pc: number) => 28 + mod(pc - 4, 12); // E1..D#2
  const styles: { name: string; why: string; make: (c: ChordAt, from: number, to: number, next: ChordAt | null) => GhostNote[] }[] = [
    {
      name: 'roots',
      why: 'roots of the chords, held',
      make: (c, from, to) => [{ pitch: low(c.root), start: from, duration: to - from, velocity: 0.8 }],
    },
    {
      name: 'root-fifth',
      why: 'root on the downbeat, fifth on beat 3',
      make: (c, from, to) => {
        const out: GhostNote[] = [];
        for (let b = from; b < to - 1e-6; b += 2) out.push({ pitch: mod(b - from, 4) < 1e-6 ? low(c.root) : low(c.root) + 7, start: b, duration: Math.min(2, to - b) - 0.05, velocity: mod(b - from, 4) < 1e-6 ? 0.85 : 0.72 });
        return out;
      },
    },
    {
      name: 'walking',
      why: 'quarter notes through the chord, with a passing note into the next one',
      make: (c, from, to, next) => {
        const pcs = chordPcs(c);
        const r = low(c.root);
        const tones = [r, r + mod(pcs[1] - c.root, 12), r + 7, r + 12];
        const out: GhostNote[] = [];
        let i = 0;
        for (let b = from; b < to - 1e-6; b += 1, i++) {
          const lastBeat = b + 1 >= to - 1e-6;
          let p = tones[i % tones.length];
          if (lastBeat && next) {
            const t = low(next.root);
            p = t + (p > t ? 1 : -1); // a semitone into the next root
          }
          out.push({ pitch: p, start: b, duration: 0.9, velocity: i % 2 ? 0.7 : 0.82 });
        }
        return out;
      },
    },
    {
      name: 'octaves',
      why: 'eighth notes jumping octaves on the root',
      make: (c, from, to) => {
        const out: GhostNote[] = [];
        let i = 0;
        for (let b = from; b < to - 1e-6; b += 0.5, i++) out.push({ pitch: low(c.root) + (i % 2 ? 12 : 0), start: b, duration: 0.45, velocity: i % 2 ? 0.7 : 0.85 });
        return out;
      },
    },
  ];
  // Faster songs first get the busier styles.
  const order = ctx.project.bpm >= 110 ? [3, 1, 2, 0] : [1, 2, 0, 3];
  return order
    .slice(0, o.count)
    .map((si, k) => {
      const st = styles[si];
      const notes: GhostNote[] = [];
      chords.forEach((c, i) => {
        const from = Math.max(0, c.start - base);
        const to = Math.min(len, c.start + c.length - base);
        notes.push(...st.make(c, from, to, chords[i + 1] ?? null).map((n) => ({ ...n, start: round4(n.start), duration: round4(Math.max(0.1, n.duration)) })));
      });
      return { kind: 'bass' as const, notes, score: round4(3 - k * 0.1), reasons: [`follows the chords (${chords.map((c) => c.chord).join(' – ')})`, st.why] };
    });
}

// ---------------------------------------------------------------- harmonize a melody

function harmonize(ctx: Context, o: Required<Pick<SuggestOptions, 'count' | 'seed'>> & { noteIds?: string[] }): Suggestion[] {
  const s = ctx.scale;
  const notes = ctx.region.notes.filter((n) => !o.noteIds?.length || o.noteIds.includes(n.id));
  if (!notes.length) return [];
  const { chords: model } = corpus();
  const first = Math.floor(Math.min(...notes.map((n) => n.start)) / BEATS_PER_BAR);
  const last = Math.ceil(Math.max(...notes.map((n) => n.start + n.duration)) / BEATS_PER_BAR - 1e-6);
  const bars = Array.from({ length: Math.max(1, last - first) }, (_, i) => first + i);
  // The diatonic triads (degrees 1..7) and how well each explains a bar's melody (strong beats count double).
  const triad = (deg: number) => [0, 2, 4].map((k) => mod(s.tonic + s.steps[mod(deg - 1 + k, 7)] + Math.floor((deg - 1 + k) / 7) * 12, 12));
  const fit = (bar: number, deg: number) => {
    const pcs = triad(deg);
    let got = 0;
    let all = 0;
    for (const n of notes) {
      const o2 = Math.min(n.start + n.duration, (bar + 1) * 4) - Math.max(n.start, bar * 4);
      if (o2 <= 0) continue;
      // The note on the downbeat counts most: it is what the ear hears against the chord.
      const downbeat = Math.abs(n.start - bar * 4) < 1e-6;
      const w = o2 * (downbeat ? 4 : strong(n.start) ? 2 : 1);
      all += w;
      if (pcs.includes(mod(n.pitch, 12))) got += w;
      else if (downbeat) got -= w * 0.5;
    }
    return all ? got / all : 0.5;
  };
  // Beam search over the bars: melody fit + the progression model.
  type Path = { degs: number[]; score: number };
  let beam: Path[] = [{ degs: [], score: 0 }];
  for (const bar of bars) {
    const next: Path[] = [];
    for (const p of beam)
      for (let d = 1; d <= 7; d++) {
        if (d === 7 && !s.minor) continue; // the diminished vii° rarely helps a pop melody
        const lp = model.logp(p.degs.slice(-2).map(String), String(d));
        const isLast = bar === bars[bars.length - 1];
        const cad = isLast && (d === 1 || d === 5 || d === 6) ? 0.6 : 0;
        const first1 = p.degs.length === 0 && (d === 1 || d === 6 || d === 4) ? 0.3 : 0;
        next.push({ degs: [...p.degs, d], score: p.score + fit(bar, d) * 4 + lp * 0.6 + cad + first1 });
      }
    beam = next.sort((a, b) => b.score - a.score).slice(0, 24);
  }
  const quality = (deg: number) => {
    const pcs = triad(deg);
    const third = mod(pcs[1] - pcs[0], 12);
    const fifth = mod(pcs[2] - pcs[0], 12);
    return fifth === 6 ? 'dim' : third === 3 ? 'm' : '';
  };
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const p of beam) {
    const sig = p.degs.join('');
    if (seen.has(sig)) continue;
    seen.add(sig);
    // Close voicings around C4, each chord moved to the inversion nearest the previous one.
    const ghost: GhostNote[] = [];
    let prevTop = 64;
    const names: string[] = [];
    p.degs.forEach((d, i) => {
      const pcs = triad(d);
      let voicing = pcs.map((pc) => 48 + mod(pc - 48, 12) + 12);
      voicing.sort((a, b) => a - b);
      for (let inv = 0; inv < 3 && Math.abs(voicing[2] - prevTop) > 6; inv++) voicing = voicing[2] > prevTop ? [voicing[2] - 12, voicing[0], voicing[1]] : [voicing[1], voicing[2], voicing[0] + 12];
      prevTop = voicing[2];
      for (const pitch of voicing) ghost.push({ pitch, start: (bars[i] - 0) * BEATS_PER_BAR, duration: BEATS_PER_BAR - 0.05, velocity: 0.62 });
      names.push(NAMES[pcs[0]] + quality(d));
    });
    const covered = bars.filter((b, i) => fit(b, p.degs[i]) >= 0.6).length;
    out.push({ kind: 'harmonize', notes: ghost, score: round4(p.score / bars.length), chords: names, newTrack: true, reasons: [`the melody's strong-beat notes are in the chord in ${covered} of ${bars.length} bars`, `a common progression: ${names.join(' – ')}`] });
    if (out.length >= o.count) break;
  }
  return out;
}

// ---------------------------------------------------------------- a counter-melody

function counter(ctx: Context, o: Required<Pick<SuggestOptions, 'count' | 'seed'>> & { noteIds?: string[] }): Suggestion[] {
  const line = monophonic(ctx.region.notes.filter((n) => !o.noteIds?.length || o.noteIds.includes(n.id)));
  if (line.length < 2) return [];
  const s = ctx.scale;
  const base = ctx.region.start;
  const mean = line.reduce((a, n) => a + n.pitch, 0) / line.length;
  const end = Math.max(...line.map((n) => n.start + n.duration));
  const out: (Candidate & { score: number })[] = [];
  for (let k = 0; k < 12; k++) {
    const rand = rng(o.seed * 31 + k + 1);
    const below = k % 3 !== 2 ? mean >= 62 : mean < 62;
    const step = k % 2 ? 2 : 1; // half notes or quarter notes, against a busier melody
    const notes: GhostNote[] = [];
    const reasons = new Set<string>([below ? 'below the melody' : 'above the melody', 'moves against it (contrary motion)']);
    let prev: number | null = null;
    for (let b = Math.floor(line[0].start); b < end - 1e-6; b += step) {
      const sounding = line.filter((n) => n.start <= b + 1e-6 && n.start + n.duration > b + 1e-6);
      const m = sounding[0] ?? line.filter((n) => n.start <= b).pop() ?? line[0];
      const mNext = line.find((n) => n.start > b) ?? m;
      const dir = Math.sign(mNext.pitch - m.pitch);
      const ch = chordAt(ctx, base + b);
      const pcs = ch ? chordPcs(ch) : [0, 2, 4].map((i) => mod(s.tonic + s.steps[i], 12));
      let target: number = prev === null ? m.pitch + (below ? -9 : 8) : prev - dir * (rand() < 0.7 ? 2 : 1);
      target = strong(base + b) ? nearestIn(target, pcs) : inScale(target, s) ? target : nearestIn(target, s.steps.map((x) => mod(x + s.tonic, 12)));
      // Never on the melody's note, nor an octave or a fifth after one (parallels).
      if (mod(target - m.pitch, 12) === 0 || (prev !== null && mod(prev - m.pitch, 12) === 7 && mod(target - m.pitch, 12) === 7)) target += below ? -3 : 3;
      if (below && target > m.pitch - 3) target -= 12;
      if (!below && target < m.pitch + 3) target += 12;
      notes.push({ pitch: target, start: round4(b), duration: round4(Math.min(step, end - b) - 0.05), velocity: 0.6 });
      prev = target;
      if (ch) reasons.add(`chord tones of ${ch.chord} on the strong beats`);
    }
    const c: Candidate = { notes, logp: 0, reasons };
    out.push({ ...c, score: rank(ctx, c, []) });
  }
  return distinct(out, o.count).map((c) => ({ kind: 'counter', notes: c.notes, score: c.score, reasons: [...c.reasons] }));
}

// ---------------------------------------------------------------- a variation of a motif

function variation(ctx: Context, o: Required<Pick<SuggestOptions, 'count' | 'seed'>>): Suggestion[] {
  const source = ctx.project.regions
    .filter((r) => r.trackId === ctx.track.id && r.id !== ctx.region.id && r.notes.length >= 3 && !r.audio)
    .sort((a, b) => b.notes.length - a.notes.length)[0];
  if (!source) return [];
  const s = ctx.scale;
  const base = ctx.region.start;
  const len = Math.min(ctx.region.length, source.length);
  const src = source.notes.filter((n) => n.start < len).sort((a, b) => a.start - b.start);
  const pivot = stepOf(src[0].pitch, s);
  const ways: { why: string; map: (step: number) => number }[] = [
    { why: `the motif of "${source.name}" a third higher, in the scale`, map: (st) => st + 2 },
    { why: `the motif of "${source.name}" a step lower (a sequence)`, map: (st) => st - 1 },
    { why: `the motif of "${source.name}" upside down (inversion)`, map: (st) => pivot - (st - pivot) },
    { why: `the motif of "${source.name}" a fourth higher`, map: (st) => st + 3 },
  ];
  return ways.slice(0, o.count).map((w, k) => {
    const reasons = [w.why, 'same rhythm'];
    const notes = src.map((n) => {
      let pitch = pitchOf(w.map(stepOf(n.pitch, s)), s);
      const ch = chordAt(ctx, base + n.start);
      if (ch && strong(base + n.start)) {
        const fixed = nearestIn(pitch, chordPcs(ch));
        if (fixed !== pitch && !reasons.includes(`adjusted to ${ch.chord} on the strong beats`)) reasons.push(`adjusted to ${ch.chord} on the strong beats`);
        pitch = fixed;
      }
      return { pitch, start: n.start, duration: n.duration, velocity: n.velocity };
    });
    return { kind: 'variation' as const, notes, score: round4(3 - k * 0.2), reasons };
  });
}

// ---------------------------------------------------------------- drums: complete the pattern, or a fill

const SNARE = 38;
const TOMS = [50, 48, 45];
const CRASH = 49;
function drums(ctx: Context, kind: 'continue' | 'drum_fill', o: Required<Pick<SuggestOptions, 'count' | 'seed'>>): Suggestion[] {
  const notes = [...ctx.region.notes].sort((a, b) => a.start - b.start);
  const len = ctx.region.length;
  const end = notes.length ? Math.max(...notes.map((n) => n.start + 0.25)) : 0;
  if (kind === 'continue') {
    if (!notes.length) return [];
    // The last written bar, repeated to the end of the bar it stopped in and the next one.
    const lastFull = Math.max(0, Math.floor(end / BEATS_PER_BAR - 1e-6));
    const bar = notes.filter((n) => Math.floor(n.start / BEATS_PER_BAR) === lastFull);
    const prevBar = lastFull > 0 ? notes.filter((n) => Math.floor(n.start / BEATS_PER_BAR) === lastFull - 1) : [];
    const pattern = (prevBar.length > bar.length ? prevBar : bar).map((n) => ({ ...n, off: n.start - Math.floor(n.start / BEATS_PER_BAR) * BEATS_PER_BAR }));
    // To the end of the bar it stopped in, and the next one if the region goes on.
    const to = Math.max((lastFull + 1) * BEATS_PER_BAR, Math.min(len, (lastFull + 2) * BEATS_PER_BAR));
    const out: GhostNote[] = [];
    for (let b = lastFull * BEATS_PER_BAR; b < to - 1e-6; b += BEATS_PER_BAR)
      for (const p of pattern) {
        const start = round4(b + p.off);
        if (start < end - 1e-6 || start >= to) continue;
        out.push({ pitch: p.pitch, start, duration: p.duration, velocity: p.velocity });
      }
    const fill = drums(ctx, 'drum_fill', { ...o, count: 1 })[0];
    return [
      { kind: 'continue' as const, notes: out, score: 3, reasons: [`repeats the groove of bar ${(prevBar.length > bar.length ? lastFull : lastFull + 1)}`] },
      ...(fill && o.count > 1 ? [fill] : []),
    ].slice(0, o.count);
  }
  // A fill on beats 3–4 of the last bar of the region, and a crash on the next downbeat when there is one.
  const lastBar = Math.max(0, Math.ceil(len / BEATS_PER_BAR) - 1);
  const from = lastBar * BEATS_PER_BAR + 2;
  const keep = notes.filter((n) => n.start >= lastBar * BEATS_PER_BAR && n.start < from);
  const kinds: { why: string; make: () => GhostNote[] }[] = [
    { why: 'a snare roll in sixteenths, getting louder', make: () => Array.from({ length: 8 }, (_, i) => ({ pitch: SNARE, start: from + i * 0.25, duration: 0.2, velocity: round4(0.5 + i * 0.06) })) },
    { why: 'down the toms, high to floor', make: () => Array.from({ length: 8 }, (_, i) => ({ pitch: TOMS[Math.min(2, Math.floor(i / 3))], start: from + i * 0.25, duration: 0.2, velocity: 0.8 })) },
    { why: 'a sparse fill: snare and toms in eighths', make: () => [SNARE, TOMS[0], SNARE, TOMS[2]].map((p, i) => ({ pitch: p, start: from + i * 0.5, duration: 0.4, velocity: 0.85 })) },
  ];
  return kinds.slice(0, o.count).map((k, i) => {
    const fill = k.make().map((n) => ({ ...n, start: round4(n.start) }));
    const crash = len > (lastBar + 1) * BEATS_PER_BAR ? [{ pitch: CRASH, start: (lastBar + 1) * BEATS_PER_BAR, duration: 1, velocity: 0.9 }] : [];
    return { kind: 'drum_fill' as const, notes: [...keep.map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity })), ...fill, ...crash].filter((n) => !notes.some((x) => Math.abs(x.start - n.start) < 1e-6 && x.pitch === n.pitch)), score: round4(3 - i * 0.2), reasons: [`a fill at the end of bar ${lastBar + 1}`, k.why] };
  });
}

// ---------------------------------------------------------------- what to suggest here

/** The kind that fits the region when none is asked for. */
export function autoKind(ctx: Context): SuggestKind {
  if (ctx.role === 'drums') return ctx.region.notes.length ? 'continue' : 'drum_fill';
  if (!ctx.region.notes.length) {
    if (ctx.role === 'bass' && ctx.chords.length) return 'bass';
    return 'variation';
  }
  return 'continue';
}

/** Up to `count` (3) suggestions for a region, best first. Instant: no network, no LLM. */
export function suggest(p: Project, regionId: string, opts: SuggestOptions = {}): { kind: SuggestKind; suggestions: Suggestion[] } {
  const ctx = contextOf(p, regionId);
  const kind = opts.kind ?? autoKind(ctx);
  const o = { count: Math.max(1, Math.min(8, opts.count ?? 3)), seed: opts.seed ?? 1, noteIds: opts.noteIds };
  let out: Suggestion[];
  if (ctx.role === 'drums' && (kind === 'continue' || kind === 'drum_fill')) out = drums(ctx, kind, o);
  else if (kind === 'continue') out = continueMelody(ctx, o);
  else if (kind === 'bass') out = bassLine(ctx, o);
  else if (kind === 'harmonize') out = harmonize(ctx, o);
  else if (kind === 'counter') out = counter(ctx, o);
  else if (kind === 'variation') out = variation(ctx, o);
  else out = drums(ctx, 'drum_fill', o);
  return { kind, suggestions: out };
}
