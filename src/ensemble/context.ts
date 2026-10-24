// The Song Context Package (OMEP 1.0 §6) of the open song: what there is and what is wanted, independent of
// any model. Built from what OpenBand already knows (sections, harmony from the notes, lyrics, track roles),
// hashed on the canonical song, and trimmed to what each engine declares it uses before it leaves.
import type { Project } from '../types';
import { noteFacts, roleOf } from '../pilot/roles';
import { BEATS_PER_BAR } from '../music';
import { analyzeChords } from '../analysis/harmony';
import { canonicalJSON } from '../versions/canonical';
import type { Manifest, Scp } from './types';

const projectEnd = (p: Project) => p.regions.reduce((m, r) => Math.max(m, r.start + r.length), 0);
const bar = (beat: number) => beat / BEATS_PER_BAR + 1;

export interface ContextOptions {
  /** Bars (1-based, to_bar exclusive) or a section. Default: the whole song. */
  scope?: { from_bar: number; to_bar: number; section_id?: string };
  intent?: Scp['intent'];
  constraints?: Scp['constraints'];
  policy?: Scp['policy'];
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function buildContext(p: Project, o: ContextOptions = {}): Promise<Scp> {
  const endBeat = Math.max(projectEnd(p), ...(p.sections ?? []).map((s) => s.start + s.length), BEATS_PER_BAR * 4);
  const lengthBars = Math.ceil(endBeat / BEATS_PER_BAR);
  const scp: Scp = { scp: '1.0', song: { title: p.name, bpm: p.bpm, meter: '4/4', key: p.key, length_bars: lengthBars } };
  if (o.scope) scp.scope = o.scope;
  if (p.sections?.length)
    scp.sections = [...p.sections].sort((a, b) => a.start - b.start).map((s) => ({ id: s.id, kind: s.kind, name: s.name, from_bar: bar(s.start), bars: s.length / BEATS_PER_BAR }));
  // Harmony from every pitched part (bass included: it settles inversions); drums never.
  const pitched = new Set(p.tracks.filter((t) => t.kind === 'instrument').map((t) => t.id));
  const notes = p.regions.filter((r) => pitched.has(r.trackId) && !r.audio).flatMap((r) => r.notes.map((n) => ({ pitch: n.pitch, start: r.start + n.start, duration: n.duration, velocity: n.velocity })));
  if (notes.length) scp.harmony = analyzeChords(notes, p.key, 0, endBeat).map((c) => ({ bar: c.bar, beat: c.beat - 1, chord: c.chord, roman: c.roman, beats: c.length }));
  scp.tracks = p.tracks.map((t) => ({ id: t.id, name: t.name, role: roleOf(t, noteFacts(p, t.id)), summary: `${t.kind} · ${t.instrument}` }));
  const melodyTrack = p.lyrics?.melodyTrackId;
  if (melodyTrack) {
    const from = ((o.scope?.from_bar ?? 1) - 1) * BEATS_PER_BAR;
    const to = o.scope ? (o.scope.to_bar - 1) * BEATS_PER_BAR : endBeat;
    scp.melody = {
      track_id: melodyTrack,
      notes: p.regions
        .filter((r) => r.trackId === melodyTrack)
        .flatMap((r) => r.notes.map((n) => ({ pitch: n.pitch, start: r.start + n.start - from, duration: n.duration, velocity: n.velocity })))
        .filter((n) => n.start >= 0 && n.start < to - from),
    };
  }
  if (p.lyrics?.lines.length)
    scp.lyrics = { language: p.lyrics.language, lines: p.lyrics.lines.map((l) => ({ text: l.text, ...(l.sectionId ? { section_id: l.sectionId } : {}), syllables: l.syllables.map((s) => ({ text: s.text, stressed: !!s.stressed })) })) };
  if (o.intent) scp.intent = o.intent;
  scp.constraints = o.constraints ?? { hard: { key: true, bpm: true, length: true, sections: true } };
  if (o.policy) scp.policy = o.policy;
  scp.context_hash = await sha256(canonicalJSON(p));
  return scp;
}

/** What `conditioning` keys need from the package; the rest is left out for that engine (privacy). */
const NEEDS: Record<string, (keyof Scp)[]> = {
  chords: ['harmony'],
  sections: ['sections'],
  melody: ['melody'],
  lyrics: ['lyrics'],
  phonemes: ['lyrics'],
  context_audio: ['context_audio'],
  stems: ['context_audio', 'tracks'],
  text: ['intent'],
  references: ['references'],
  energy: ['sections'],
};
const ALWAYS: (keyof Scp)[] = ['scp', 'song', 'scope', 'constraints', 'policy', 'context_hash'];

/** The package an engine receives: only what it declares in the manifest for that capability. */
export function minimizeContext(scp: Scp, manifest: Manifest, capability: string): Scp {
  const cond = manifest.capabilities[capability as keyof Manifest['capabilities']]?.conditioning;
  // Engines that run inside OpenBand see everything.
  if (!cond || manifest.runtime.where === 'builtin') return scp;
  const keep = new Set<keyof Scp>([...ALWAYS, 'intent', ...cond.flatMap((c) => NEEDS[c] ?? [])]);
  return Object.fromEntries(Object.entries(scp).filter(([k]) => keep.has(k as keyof Scp))) as unknown as Scp;
}

/** Which parts of the song a request would send to an engine (for the "what leaves" note in the UI). */
export const sentParts = (scp: Scp) => Object.keys(scp).filter((k) => !ALWAYS.includes(k as keyof Scp));
