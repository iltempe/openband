import type { Note, Project, Region } from '../types';

/** FNV-1a hash → short base-36 string, for stable issue ids. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (p: number) => `${NOTE[p % 12]}${Math.floor(p / 12) - 1}`;

/** Notes that actually play (inside the region), in song beats. */
export interface PlayedNote extends Note {
  at: number;
  end: number;
  regionId: string;
  trackId: string;
}

export function playedNotes(_p: Project, r: Region): PlayedNote[] {
  return r.notes
    .filter((n) => n.start >= 0 && n.start < r.length)
    .map((n) => ({ ...n, at: r.start + n.start, end: r.start + Math.min(n.start + n.duration, r.length), regionId: r.id, trackId: r.trackId }));
}

export const melodicTracks = (p: Project) => p.tracks.filter((t) => t.kind === 'instrument');
export const regionsOf = (p: Project, trackId: string) => p.regions.filter((r) => r.trackId === trackId && !r.audio);
export const BEATS_PER_BAR = 4;
