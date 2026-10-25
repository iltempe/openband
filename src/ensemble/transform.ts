// transform (SPEC v0.6 §8.1): change a part that is there — continue it, harmonize it, repaint or
// restyle it — through the same router and engines as create. The region's notes are the melody the
// engines read; the result lands as takes of that region (to compare and blind-test), or for a
// harmony on a new track. Nothing the user wrote is overwritten.
import { useStore } from '../store';
import { BEATS_PER_BAR } from '../music';
import { createPart } from './create';

export interface TransformArgs {
  capability?: string;
  region_id?: string;
  track_id?: string;
  section_id?: string;
  from_bar?: number;
  to_bar?: number;
  /** What to do, in words ("harmonize with jazz chords", "make it a bossa"). */
  intent?: string;
  variants?: number;
  engine?: string;
  seed?: number;
}

/** The capability a sentence asks for, when none is given. */
export function transformCapability(intent = ''): string {
  const t = intent.toLowerCase();
  if (/harmoni[sz]|armonizz|chords? (for|under)|accordi (per|sotto)/.test(t)) return 'symbolic.harmonize';
  if (/continu|extend|go on|prosegu|allung|next bars?/.test(t)) return 'symbolic.continue';
  if (/restyle|in the style|style of|nello stile|as an? \w+|come un[ao]? /.test(t)) return 'music.restyle';
  return 'music.repaint';
}

export async function transformPart(a: TransformArgs) {
  const p = useStore.getState().project;
  const region = a.region_id ? p.regions.find((r) => r.id === a.region_id) : undefined;
  if (a.region_id && !region) throw new Error(`Region "${a.region_id}" not found`);
  const trackId = region?.trackId ?? a.track_id;
  if (!trackId && !a.section_id && a.from_bar === undefined) throw new Error('Say what to transform: region_id, or track_id with section_id or bars');
  const bars = region ? { from_bar: region.start / BEATS_PER_BAR + 1, to_bar: (region.start + region.length) / BEATS_PER_BAR } : { from_bar: a.from_bar, to_bar: a.to_bar };
  const capability = a.capability ?? transformCapability(a.intent);
  const common = { capability, text: a.intent, section_id: region ? undefined : a.section_id, ...bars, melody_track_id: trackId, variants: a.variants, engine: a.engine, seed: a.seed };
  // A harmony is a new part (on a new track); the rest are other versions of the same part.
  const out = capability === 'symbolic.harmonize' ? await createPart({ ...common, text: a.intent || 'harmony' }) : await createPart({ ...common, track_id: trackId });
  return { transformed: region?.id ?? trackId ?? null, ...out };
}
