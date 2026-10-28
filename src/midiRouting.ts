// Which tracks play a live MIDI note (issue #9). Tracks that listen to a channel (and maybe a device) get
// what arrives there, selected or not, several at once if they share it (layers); what no track claims goes
// to the selected track, as before. Pure.
import type { Track } from './types';

export interface MidiSource {
  /** 1..16 */
  channel: number;
  device?: string;
  /** Never this track (a plugin's own track, so what it plays doesn't come back to it). */
  exclude?: string;
  /** What no track claims goes to the selected track (default); a plugin's notes are dropped instead. */
  fallback?: boolean;
}

export function routeMidi(tracks: Pick<Track, 'id' | 'kind' | 'midiIn'>[], selected: string | null | undefined, src: MidiSource): string[] {
  const claimed = tracks.filter((t) => t.id !== src.exclude && t.kind !== 'audio' && t.midiIn && t.midiIn.channel === src.channel && (!t.midiIn.device || t.midiIn.device === src.device)).map((t) => t.id);
  if (claimed.length || src.fallback === false) return claimed;
  // The selected track takes the rest — unless it listens to a channel of its own.
  const sel = tracks.find((t) => t.id === selected) ?? tracks[0];
  return sel && !sel.midiIn ? [sel.id] : [];
}

/** Channels 1..16 to the instrument and drum tracks, in order (a multitimbral setup in one gesture). */
export function channelMap(tracks: Pick<Track, 'id' | 'kind'>[], device?: string): Record<string, { channel: number; device?: string }> {
  const out: Record<string, { channel: number; device?: string }> = {};
  tracks
    .filter((t) => t.kind !== 'audio')
    .slice(0, 16)
    .forEach((t, i) => (out[t.id] = { channel: i + 1, ...(device ? { device } : {}) }));
  return out;
}
