// The conformance pipeline (SPEC v0.6 §5), steps 1–4: whatever an engine made, it is measured against the
// song and brought in line — tempo, key, length and range are the studio's guarantee, not the model's.
// Pure: notes in, notes out; for audio a plan (stretch, pitch, repeats, trim) that the insertion step
// applies with the non-destructive clip settings of F23. Every correction is written down, in words, for
// the contribution's provenance (`conform`).
import { BEATS_PER_BAR, keyInterval } from '../music';
import { keyFromProfile, profileFromAudio, profileFromNotes, sameKey, sameScale, scalePitchClasses } from '../analysis/key';
import { detectTempo } from '../audio/stretch';
import type { Contribution, Scp, ScpNote } from './types';
import { scopeOf } from './builtin';

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const pc = (key: string) => (keyInterval('C', key.replace(/m$/, '')) + 120) % 12;
const shiftKey = (key: string, semis: number) => NAMES[(pc(key) + semis + 120) % 12] + (/m$/.test(key) ? 'm' : '');

/** The smallest move (−6…+5 semitones) that puts `from`'s scale on `to`'s (relative keys count as equal). */
export function nearestShift(from: string, to: string): number | null {
  let best: number | null = null;
  for (let s = -6; s <= 5; s++) if (sameScale(shiftKey(from, s), to) && (best === null || Math.abs(s) < Math.abs(best))) best = s;
  return best;
}

/** Light structural check (the full JSON Schema check is omep-conformance's job). */
export function checkContribution(c: unknown): string | null {
  const x = c as Contribution | null;
  if (!x || typeof x !== 'object') return 'no contribution';
  if (!['audio', 'notes', 'stems', 'params', 'stream'].includes(x.kind)) return `unknown kind "${(x as { kind?: string }).kind}"`;
  if (!x.provenance?.engine) return 'no provenance';
  if (!x.license?.commercial) return 'no licence';
  if (x.kind === 'notes' && !Array.isArray(x.notes)) return 'notes missing';
  if ((x.kind === 'audio' || x.kind === 'stems') && !x.files?.length) return 'files missing';
  return null;
}

const inKey = (notes: ScpNote[], key: string) => {
  const pcs = scalePitchClasses(key);
  return notes.length ? notes.filter((n) => pcs.has(((n.pitch % 12) + 12) % 12)).length / notes.length : 1;
};
const noteNumber = (name: string) => {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  return m ? (Number(m[3]) + 1) * 12 + pc(m[1]) + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) : null;
};

export interface ConformedNotes {
  notes: ScpNote[];
  conform: string[];
  /** The key the notes sound in, after the corrections. */
  key: string | null;
}

/** Steps 1, 3, 4 for notes (tempo is already the song's: notes are in beats). */
export function conformNotes(c: Contribution, scp: Scp, opts: { drums?: boolean } = {}): ConformedNotes {
  const s = scopeOf(scp);
  const beats = s.bars * BEATS_PER_BAR;
  const conform: string[] = [];
  let notes = (c.notes ?? []).map((n) => ({ ...n }));
  // 1. claims
  if (c.claims.length_bars !== undefined && Math.abs(c.claims.length_bars - s.bars) > 0.01) conform.push(`claimed ${c.claims.length_bars} bars, the scope is ${s.bars}`);
  let key: string | null = null;
  if (!opts.drums && notes.length) {
    const measured = keyFromProfile(profileFromNotes(notes.map((n) => ({ pitch: n.pitch, duration: n.duration, velocity: n.velocity ?? 0.8 }))))?.key ?? null;
    if (c.claims.key && measured && !sameKey(c.claims.key, measured) && !sameScale(c.claims.key, measured)) conform.push(`claimed ${c.claims.key}, sounds in ${measured}`);
    // 3. key: move the whole part if that brings it (almost) entirely into the song's key.
    const ratio = inKey(notes, scp.song.key);
    if (ratio < 0.75) {
      let best = { s: 0, r: ratio };
      for (let t = -6; t <= 5; t++) {
        const r = inKey(notes.map((n) => ({ ...n, pitch: n.pitch + t })), scp.song.key);
        if (r > best.r + 1e-9 || (Math.abs(r - best.r) < 1e-9 && Math.abs(t) < Math.abs(best.s))) best = { s: t, r };
      }
      if (best.s && best.r >= 0.9) {
        notes = notes.map((n) => ({ ...n, pitch: n.pitch + best.s }));
        conform.push(`pitch ${best.s > 0 ? '+' : ''}${best.s} st into ${scp.song.key} (${Math.round(ratio * 100)}% → ${Math.round(best.r * 100)}% in key)`);
      } else conform.push(`${Math.round(ratio * 100)}% of the notes are in ${scp.song.key}`);
    }
    key = keyFromProfile(profileFromNotes(notes.map((n) => ({ pitch: n.pitch, duration: n.duration, velocity: n.velocity ?? 0.8 }))))?.key ?? measured;
    // Range: whole octaves, when most of the part sits outside it.
    const range = scp.constraints?.hard?.range?.map(noteNumber);
    if (range && range[0] !== null && range[1] !== null) {
      const mid = notes.reduce((a, n) => a + n.pitch, 0) / notes.length;
      const centre = (range[0]! + range[1]!) / 2;
      const oct = Math.round((centre - mid) / 12);
      const outside = notes.filter((n) => n.pitch < range[0]! || n.pitch > range[1]!).length / notes.length;
      if (oct && outside > 0.5) {
        notes = notes.map((n) => ({ ...n, pitch: n.pitch + 12 * oct }));
        conform.push(`octave ${oct > 0 ? '+' : ''}${oct} into the range ${scp.constraints!.hard!.range!.join('–')}`);
      }
    }
  }
  // 4. length: nothing before the scope or past its end, durations cut at the end.
  const before = notes.length;
  notes = notes
    .filter((n) => n.start >= -1e-6 && n.start < beats - 1e-6)
    .map((n) => ({ ...n, start: Math.max(0, n.start), duration: Math.min(n.duration, beats - n.start) }));
  if (notes.length < before) conform.push(`${before - notes.length} note(s) outside the scope dropped`);
  return { notes, conform, key };
}

export interface AudioPlan {
  /** The audio's own tempo (measured, or claimed when the measurement agrees). */
  sourceBpm: number;
  /** Follow the song's tempo (F23 time-stretch) when the tempos differ. */
  stretch: boolean;
  /** Semitones (F23 pitch shift). */
  pitch: number;
  /** Bars the audio lasts at the song's tempo. */
  bars: number;
  /** How many times to place it to fill the scope (loops), and the length of the last one. */
  repeats: number;
  lastBars: number;
  conform: string[];
}

/** Steps 1–4 for audio, on the decoded PCM. */
export function planAudio(c: Contribution, scp: Scp, pcm: { mono: Float32Array; sampleRate: number; name?: string }): AudioPlan {
  const s = scopeOf(scp);
  const conform: string[] = [];
  const seconds = pcm.mono.length / pcm.sampleRate;
  // 1–2. tempo. The duration is the most reliable witness: a loop of N bars at B BPM lasts exactly
  // N·4·60/B seconds. Onset-based detection misreads swung grooves (lo-fi, boom-bap) by ratios like 1.4,
  // so it only decides when the engine declares nothing.
  const claimed = c.claims.bpm ?? c.alignment?.bpm_detected;
  const claimedBars = c.claims.length_bars;
  const fromLength = claimedBars ? (claimedBars * BEATS_PER_BAR * 60) / seconds : null;
  let sourceBpm: number;
  let confirmed = false;
  if (claimed && fromLength && Math.abs(fromLength / claimed - 1) < 0.01) {
    sourceBpm = claimed;
    confirmed = true;
  }
  else if (fromLength && !claimed) sourceBpm = fromLength;
  else if (claimed) {
    sourceBpm = claimed;
    if (fromLength) conform.push(`claimed ${claimed} BPM over ${claimedBars} bars, but it lasts ${seconds.toFixed(2)} s (${fromLength.toFixed(1)} BPM)`);
  } else {
    const det = detectTempo(pcm.mono, pcm.sampleRate, pcm.name ?? '');
    sourceBpm = det.bpm > 0 ? det.bpm : scp.song.bpm;
    if (det.bpm > 0) conform.push(`tempo measured: ${det.bpm.toFixed(1)} BPM`);
  }
  const stretch = Math.abs(sourceBpm / scp.song.bpm - 1) > 0.005;
  if (stretch) conform.push(`stretch ${((scp.song.bpm / sourceBpm - 1) * 100).toFixed(1)}% (${+sourceBpm.toFixed(2)} → ${scp.song.bpm} BPM)`);
  // 3. key: drums and other unpitched parts have none.
  const unpitched = /drum|perc|beat|groove/.test(`${c.files?.[0]?.role ?? ''} ${c.provenance.prompt ?? ''}`.toLowerCase());
  let pitch = 0;
  if (!unpitched) {
    // Audio key analysis is fragile on low or monophonic parts (a bass line can read a tritone off), so a
    // declared key wins; the analysis decides only when nothing is declared, and a confident disagreement
    // is reported, not acted on.
    const measured = keyFromProfile(profileFromAudio(pcm.mono, pcm.sampleRate));
    const src = c.claims.key ?? (measured && measured.confidence > 0.5 ? measured.key : null);
    if (c.claims.key && measured && measured.confidence > 0.8 && !sameScale(c.claims.key, measured.key)) conform.push(`claimed ${c.claims.key}; the analysis hears ${measured.key} (kept ${c.claims.key})`);
    if (src && !sameScale(src, scp.song.key)) {
      const shift = nearestShift(src, scp.song.key);
      if (shift) {
        pitch = shift;
        conform.push(`pitch ${shift > 0 ? '+' : ''}${shift} st (${src} → ${scp.song.key})`);
      }
    }
  }
  // 4. length: repeat a short loop to fill the scope, trim what's longer.
  // N beats at the audio's own tempo stay N beats once it follows the song's.
  const unit = confirmed && claimedBars ? claimedBars : (seconds * sourceBpm) / 60 / BEATS_PER_BAR;
  let repeats = 1;
  let lastBars = Math.min(unit, s.bars);
  if (unit < s.bars - 0.25 && unit >= 0.5) {
    // A leftover under a twentieth of a bar is rounding, not another repetition.
    repeats = Math.ceil(s.bars / unit - 0.05);
    lastBars = s.bars - unit * (repeats - 1);
    conform.push(`repeated ×${repeats} to fill ${s.bars} bars`);
  } else if (unit > s.bars + 0.01) conform.push(`trimmed to ${s.bars} bars`);
  return { sourceBpm, stretch, pitch, bars: unit, repeats, lastBars, conform };
}
