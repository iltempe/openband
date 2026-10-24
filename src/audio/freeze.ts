// The render cache of native plugins (G8.4): a track that plays native plugins keeps its audio "frozen" —
// rendered with its instrument and effects, before its fader — so the song plays everywhere: in the
// browser, in the online studio, on a computer without the plugin. Volume, pan and sends stay live on
// top. The desktop app freezes when the song is saved as .openband, and only what changed since.
import type { Project, Track } from '../types';
import { crc32 } from '../pluginHistory';

/** The native plugins a track plays (its instrument, its effects), by name. */
export function nativePluginsOf(p: Project, t: Track): string[] {
  const inst = p.instruments?.find((i) => i.id === t.instrument && i.source === 'native');
  const fx = (t.fx?.plugins ?? []).filter((s) => s.on && s.format && s.format !== 'wam' && s.format !== 'test');
  return [...(inst ? [inst.name] : []), ...fx.map((s) => s.name)];
}

/**
 * What the frozen audio depends on: the track's notes and clips, the tempo, its instrument (with the
 * plugin's state), its effects and their automation. Not its fader, pan, sends or mute: those stay live.
 */
export function trackHash(p: Project, t: Track): string {
  const regions = p.regions.filter((r) => r.trackId === t.id).map(({ id: _id, name: _name, ...r }) => r);
  const inst = p.instruments?.find((i) => i.id === t.instrument);
  const lanes = (t.automation ?? []).filter((l) => l.target.kind !== 'mix');
  return crc32(JSON.stringify([regions, p.bpm, inst ?? t.instrument, t.fx ?? null, lanes, t.cutoff])).toString(16);
}

/** Does this track play its frozen audio instead of its plugins? Only where the plugins can't run. */
export function usesFrozen(p: Project, t: Track, o: { desktop: boolean; failed: (key: string) => boolean }) {
  if (!t.frozen || !nativePluginsOf(p, t).length) return false;
  if (!o.desktop) return true;
  const keys = [`${t.id}:instrument`, ...(t.fx?.plugins ?? []).map((s) => `${t.id}:${s.id}`)];
  return keys.some(o.failed);
}

/** Is the frozen audio older than the track (notes or sound changed since)? */
export const frozenStale = (p: Project, t: Track) => !!t.frozen && t.frozen.hash !== trackHash(p, t);

/** The track as it is frozen: fader at 0 dB, centred, no sends, playing, no mix automation. */
export function freezeView(p: Project, trackId: string): Project {
  const q = structuredClone(p);
  for (const t of q.tracks) {
    if (t.id !== trackId) continue;
    t.volume = 0.8;
    t.pan = 0;
    t.reverb = 0;
    t.delay = 0;
    t.mute = false;
    t.solo = false;
    delete t.polarity;
    delete t.frozen;
    t.automation = (t.automation ?? []).filter((l) => l.target.kind !== 'mix');
  }
  return q;
}
