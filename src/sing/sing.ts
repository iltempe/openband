// sing (SPEC v0.6 §8.1, voice.sing): a voice sings the melody on the lyrics. OpenBand hands the engine the
// notes, the syllables on them and their phonemes (Italian from g2p.it); the router picks who sings —
// OpenBand's guide voice by default, DiffSinger or another singing engine when the user has one.
import { useStore } from '../store';
import { BEATS_PER_BAR } from '../music';
import { createPart } from '../ensemble/create';

export interface SingArgs {
  /** The melody track (default: the lyrics' melody track). */
  track_id?: string;
  section_id?: string;
  from_bar?: number;
  to_bar?: number;
  /** The voice, in words ("warm, breathy"), for engines that take it. */
  voice?: string;
  engine?: string;
  variants?: number;
  seed?: number;
  confirm_spend?: boolean;
}

export async function singPart(a: SingArgs) {
  const p = useStore.getState().project;
  const melody = a.track_id ?? p.lyrics?.melodyTrackId;
  if (!melody) throw new Error('Which melody should be sung? Give track_id, or set the melody track of the lyrics');
  const track = p.tracks.find((t) => t.id === melody);
  if (!track) throw new Error(`Track "${melody}" not found`);
  const regions = p.regions.filter((r) => r.trackId === melody && r.notes.length);
  if (!regions.length) throw new Error(`"${track.name}" has no notes to sing`);
  // Without a section or bars: the whole melody.
  const bars =
    a.section_id || a.from_bar !== undefined
      ? { section_id: a.section_id, from_bar: a.from_bar, to_bar: a.to_bar }
      : { from_bar: Math.floor(Math.min(...regions.map((r) => r.start)) / BEATS_PER_BAR) + 1, to_bar: Math.ceil(Math.max(...regions.map((r) => r.start + r.length)) / BEATS_PER_BAR) };
  const words = p.lyrics?.lines.reduce((n, l) => n + l.syllables.length, 0) ?? 0;
  const out = await createPart({ capability: 'voice.sing', melody_track_id: melody, text: a.voice ?? 'Voice', role: 'vocal', ...bars, engine: a.engine, variants: a.variants, seed: a.seed, confirm_spend: a.confirm_spend });
  return { ...out, sung: words ? `${track.name} with the lyrics (${p.lyrics!.language})` : `${track.name} on "a" (no lyrics yet: set_lyrics, then align_lyrics)` };
}
