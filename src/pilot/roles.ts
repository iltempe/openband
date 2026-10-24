// What each track does in the mix (G1): kick, drums, bass, harmony, lead, vocal, texture or fx. The
// user's choice (Track.role) wins; otherwise from the name (Italian and English), the kind and preset,
// the notes (register, how many at once) and, for audio, the band that dominates it. Pure.
import type { MixRole, Project, Track } from '../types';
import { PRESETS } from '../audio/instruments';
import type { BandId } from '../analysis/spectrum';

/** Per-track facts the classifier can use. */
export interface RoleFacts {
  /** Mean MIDI pitch of the notes, if any. */
  meanPitch?: number;
  lowestPitch?: number;
  /** Share of notes sounding together with another one, 0..1. */
  polyphony?: number;
  /** Band with the most energy (from a render), for audio tracks. */
  dominant?: BandId;
}

export function noteFacts(p: Project, trackId: string): RoleFacts {
  const notes = p.regions.filter((r) => r.trackId === trackId && !r.audio).flatMap((r) => r.notes.filter((n) => n.start < r.length).map((n) => ({ s: r.start + n.start, e: r.start + n.start + n.duration, pitch: n.pitch })));
  if (!notes.length) return {};
  notes.sort((a, b) => a.s - b.s);
  let together = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const prev = notes[i - 1];
    const next = notes[i + 1];
    if ((prev && prev.e > n.s + 0.01) || (next && next.s < n.e - 0.01)) together++;
  }
  return { meanPitch: notes.reduce((a, n) => a + n.pitch, 0) / notes.length, lowestPitch: notes.reduce((a, n) => Math.min(a, n.pitch), 127), polyphony: together / notes.length };
}

const NAME_RULES: [RegExp, MixRole][] = [
  [/\b(kick|cassa|bd|bass ?drum)\b/, 'kick'],
  [/\b(vox|voc|voce|voci|vocal|vocals|voice|canto|cori|choir|backing|bv)/, 'vocal'],
  [/\b(fx|sfx|riser|sweep|impact|noise|rumore|effett)/, 'fx'],
  [/\b(bass|basso|808|sub)\b/, 'bass'],
  [/\b(drum|drums|batteria|perc|percussion|hats?|snare|rullante|loop ?drum)/, 'drums'],
  [/\b(lead|solo|melod|hook|riff)/, 'lead'],
  [/\b(pad|strings|archi|atmo|ambient|texture|drone)/, 'texture'],
  [/\b(piano|keys|tastier|chord|accord|guitar|chitarra|gtr|organ|organo|rhodes|ep)\b/, 'harmony'],
];

/** The role the pilot would give a track on its own (Track.role ignored). */
export function autoRole(t: Track, facts: RoleFacts = {}): MixRole {
  const name = t.name.toLowerCase();
  for (const [re, role] of NAME_RULES) if (re.test(name)) return t.kind === 'drums' && role !== 'kick' && role !== 'fx' ? 'drums' : role;
  if (t.kind === 'drums') return 'drums';
  const cat = PRESETS.find((x) => x.id === t.instrument)?.category;
  if (cat === 'Bass') return 'bass';
  if (cat === 'Pads & Strings') return 'texture';
  if (facts.meanPitch !== undefined) {
    if (facts.meanPitch < 48) return 'bass';
    if ((facts.polyphony ?? 0) < 0.25 && facts.meanPitch >= 60) return 'lead';
    if (cat === 'Synth' && (facts.polyphony ?? 0) < 0.25) return 'lead';
    return 'harmony';
  }
  if (t.kind === 'audio') {
    if (facts.dominant === 'sub' || facts.dominant === 'bass') return 'bass';
    return 'texture';
  }
  return cat === 'Synth' ? 'lead' : 'harmony';
}

/** The role in the mix: the user's, or the automatic one. */
export const roleOf = (t: Track, facts?: RoleFacts): MixRole => t.role ?? autoRole(t, facts);

/** Mix priority, highest first: who keeps a band when two tracks fight over it. In the low bands the
 *  kick comes first — a drum track carries one — then the bass. */
const PRIORITY: MixRole[] = ['vocal', 'lead', 'kick', 'bass', 'drums', 'harmony', 'texture', 'fx'];
const PRIORITY_LOW: MixRole[] = ['kick', 'drums', 'bass', 'vocal', 'lead', 'harmony', 'texture', 'fx'];

export function priority(role: MixRole, band: BandId): number {
  const list = band === 'sub' || band === 'bass' ? PRIORITY_LOW : PRIORITY;
  return list.length - list.indexOf(role);
}
