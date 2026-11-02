// Vertical clips (C3): from any part of the studio to a 9:16 video. The choices are pure and tested here; the
// drawing is in the video worker.
import type { Project } from '../types';
import { BEATS_PER_BAR } from '../music';
import { analyzeChords } from '../analysis/harmony';
import { energyProfile } from '../structure';

export type ClipSource =
  | { kind: 'song' }
  | { kind: 'section'; section_id: string }
  | { kind: 'range'; from_bar: number; to_bar: number }
  | { kind: 'track'; track_id: string; context: 'solo' | 'focus' }
  | { kind: 'take'; region_id: string; take_id: string }
  | { kind: 'rehearsal'; session_id: string; section_id?: string }
  | { kind: 'before_after'; proposal: number }
  | { kind: 'before_after'; a: string; b: string };

export const LOOKS = [
  { id: 'spectrum', name: 'Spectrum', good: 'a whole song' },
  { id: 'pianoroll', name: 'Piano roll', good: 'a riff, "learn the part"' },
  { id: 'waveform', name: 'Waveform', good: 'a voice, a recorded guitar' },
  { id: 'chords', name: 'Chords', good: 'covers, "play along"' },
  { id: 'studio', name: 'Studio', good: '"how I made it"' },
  { id: 'before_after', name: 'Before and after', good: 'a proposal, a mix' },
  { id: 'camera', name: 'Camera', good: 'a performance' },
] as const;
export type Look = (typeof LOOKS)[number]['id'];

const sec = (p: Project, beats: number) => (beats * 60) / p.bpm;

/** Which stretch of the song a source shows, in seconds. */
export function clipRange(p: Project, s: ClipSource, songSeconds: number, maxSeconds = 30) {
  const clamp = (from: number, to: number) => ({ from, to: Math.min(to, from + maxSeconds, songSeconds) });
  const region = (id: string) => p.regions.find((r) => r.id === id);
  if (s.kind === 'section' || (s.kind === 'rehearsal' && s.section_id)) {
    const id = s.kind === 'section' ? s.section_id : s.section_id;
    const x = p.sections?.find((y) => y.id === id);
    if (!x) throw new Error(`Section "${id}" not found. Call get_structure.`);
    return clamp(sec(p, x.start), sec(p, x.start + x.length));
  }
  if (s.kind === 'rehearsal') {
    const r = p.rehearsals?.find((x) => x.id === s.session_id);
    const first = p.sections?.find((x) => x.id === r?.sections[0]);
    if (!first) throw new Error(`Rehearsal "${s.session_id}" not found`);
    return clamp(sec(p, first.start), sec(p, first.start + first.length));
  }
  if (s.kind === 'range') return clamp(sec(p, (s.from_bar - 1) * BEATS_PER_BAR), sec(p, (s.to_bar - 1) * BEATS_PER_BAR));
  if (s.kind === 'take') {
    const r = region(s.region_id);
    if (!r) throw new Error(`Region "${s.region_id}" not found`);
    return clamp(sec(p, r.start), sec(p, r.start + r.length));
  }
  if (s.kind === 'track') {
    const rs = p.regions.filter((r) => r.trackId === s.track_id);
    if (!rs.length) throw new Error('That track has nothing on it');
    return clamp(sec(p, Math.min(...rs.map((r) => r.start))), sec(p, Math.max(...rs.map((r) => r.start + r.length))));
  }
  return clamp(0, songSeconds);
}

/**
 * A perfect loop: the tail crosses into the head over one bar, and the clip ends a bar earlier, on the downbeat.
 * Mutates nothing; gives new buffers.
 */
export function loopChannels(channels: Float32Array[], crossfade: number) {
  const n = channels[0].length;
  const x = Math.min(crossfade, Math.floor(n / 2));
  return channels.map((c) => {
    const out = c.slice(0, n - x);
    for (let i = 0; i < x; i++) {
      const t = i / x;
      out[i] = c[n - x + i] * Math.cos((t * Math.PI) / 2) + c[i] * Math.sin((t * Math.PI) / 2);
    }
    return out;
  });
}

/** What the looks need from the song, in seconds from the start of the clip. */
export function clipNotes(p: Project, from: number, to: number, focus?: string) {
  const spb = 60 / p.bpm;
  const out: { t: number; d: number; pitch: number; color: string; on: boolean }[] = [];
  for (const r of p.regions) {
    const track = p.tracks.find((t) => t.id === r.trackId);
    if (!track || track.mute || track.kind === 'drums' || r.audio) continue;
    for (const n of r.notes) {
      const t = (r.start + n.start) * spb - from;
      if (t + n.duration * spb < 0 || t > to - from) continue;
      out.push({ t, d: n.duration * spb, pitch: n.pitch, color: track.color, on: !focus || track.id === focus });
    }
  }
  return out;
}

export function clipChords(p: Project, from: number, to: number) {
  const spb = 60 / p.bpm;
  const melodic = new Set(p.tracks.filter((t) => t.kind === 'instrument' && !t.mute).map((t) => t.id));
  const notes = p.regions.filter((r) => melodic.has(r.trackId) && !r.audio).flatMap((r) => r.notes.map((n) => ({ ...n, start: r.start + n.start })));
  return analyzeChords(notes as never, p.key, from / spb, to / spb).map((c) => ({ t: c.start * spb - from, chord: c.chord }));
}

export function clipTracks(p: Project, from: number, to: number) {
  const spb = 60 / p.bpm;
  return p.tracks.map((t) => ({ name: t.name, color: t.color, spans: p.regions.filter((r) => r.trackId === t.id).map((r) => [r.start * spb - from, (r.start + r.length) * spb - from] as [number, number]).filter(([a, b]) => b > 0 && a < to - from) }));
}

export interface ClipSuggestion {
  source: ClipSource;
  look: Look;
  title: string;
  hashtags: string[];
  from: number;
  to: number;
  score: number;
  why: string;
}

/** The three best windows. Deterministic: the same song gives the same three. */
export function suggestClips(p: Project, seconds = 20): ClipSuggestion[] {
  const spb = 60 / p.bpm;
  const sections = [...(p.sections ?? [])].sort((a, b) => a.start - b.start);
  const end = p.regions.reduce((m, r) => Math.max(m, r.start + r.length), 0);
  const list = sections.length ? sections : Array.from({ length: Math.max(1, Math.ceil(end / 32)) }, (_, i) => ({ id: `w${i}`, name: `Bars ${i * 8 + 1}–${i * 8 + 8}`, kind: 'custom' as const, start: i * 32, length: 32 }));
  const counts = new Map<string, number>();
  for (const s of list) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const scored = list.map((s, i) => {
    const e = energyProfile(p, s.start, s.start + s.length);
    // Who plays, how much and how hard, 0..1.
    const energy = Math.min(1, e.active_tracks.length / 6 + e.notes_per_bar / 32) * (e.mean_velocity || 0.5);
    const chorus = s.kind === 'chorus' ? 1 : 0;
    const repeated = (counts.get(s.kind) ?? 1) > 1 && s.kind !== 'custom' ? 0.3 : 0;
    const solo = s.kind === 'solo' ? 0.5 : 0;
    const good = (p.flubs ?? []).filter((f) => f.kind === 'good' && f.beat >= s.start && f.beat < s.start + s.length).length * 0.4;
    return { s, i, score: +(chorus + repeated + solo + good + energy).toFixed(3), why: chorus ? 'the chorus' : solo ? 'the solo' : good ? 'a take you marked good' : 'the most energy' };
  });
  const melodic = p.tracks.some((t) => t.kind === 'instrument');
  const words = !!p.lyrics?.lines?.length;
  const genre = p.release?.genre ? [`#${String(p.release.genre).replace(/\s+/g, '')}`] : [];
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 3)
    .map(({ s, score, why }, n) => ({
      source: sections.length ? { kind: 'section', section_id: s.id } : { kind: 'range', from_bar: Math.floor(s.start / BEATS_PER_BAR) + 1, to_bar: Math.floor((s.start + s.length) / BEATS_PER_BAR) + 1 },
      look: words ? 'chords' : melodic && n !== 1 ? 'pianoroll' : 'studio',
      title: p.release?.title || p.name,
      hashtags: ['#newmusic', '#openband', ...genre],
      from: s.start * spb,
      to: Math.min((s.start + s.length) * spb, s.start * spb + seconds),
      score,
      why,
    }));
}
