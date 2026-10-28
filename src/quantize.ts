// Quantize (issue #10): notes towards a grid, in full or by a strength, with swing on the off-beat grid
// points, their ends too. The grid is the song's (absolute beats), so regions that don't start on it are
// quantized like the rest. Pure.
import type { Note } from './types';

export interface QuantizeOptions {
  /** Beats: 1 = quarter, 0.5 = 8th, 0.25 = 16th; 1/3, 1/6 for triplets. */
  grid: number;
  /** 0..1: how far each note moves towards its grid point (1 = all the way). */
  strength?: number;
  /** 0..0.75: how late the off-beat grid points are, as a share of the grid (0.33 ≈ triplet feel). */
  swing?: number;
  /** Move note ends to the grid too (default true). */
  ends?: boolean;
}

export const GRIDS = [
  { id: '1/4', beats: 1 },
  { id: '1/8', beats: 0.5 },
  { id: '1/16', beats: 0.25 },
  { id: '1/32', beats: 0.125 },
  { id: '1/8T', beats: 1 / 3 },
  { id: '1/16T', beats: 1 / 6 },
] as const;

/** The grid point nearest to t, with swing on the odd ones. */
export function gridPoint(t: number, grid: number, swing = 0): number {
  const i = Math.round(t / grid);
  let best = Infinity;
  let at = t;
  for (const k of [i - 1, i, i + 1]) {
    const p = k * grid + (k % 2 !== 0 ? swing * grid : 0);
    if (Math.abs(p - t) < best) {
      best = Math.abs(p - t);
      at = p;
    }
  }
  return at;
}

/** Quantized copies of a region's notes (start relative to the region at regionStart). */
export function quantizeNotes(notes: Note[], regionStart: number, o: QuantizeOptions): Note[] {
  const g = o.grid;
  if (!(g > 0)) throw new Error('The grid must be more than 0 beats');
  const s = Math.max(0, Math.min(1, o.strength ?? 1));
  const swing = Math.max(0, Math.min(0.75, o.swing ?? 0));
  const ends = o.ends !== false;
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return notes.map((n) => {
    const at = regionStart + n.start;
    const start = Math.max(regionStart, at + (gridPoint(at, g, swing) - at) * s);
    let end = at + n.duration;
    if (ends) end = end + (gridPoint(end, g, swing) - end) * s;
    // A note never shrinks to nothing: at least half a grid step (or what it was, if shorter).
    const duration = Math.max(Math.min(n.duration, g / 2), end - start);
    return { ...n, start: round(start - regionStart), duration: round(duration) };
  });
}

/** How many notes a quantize moved (more than a hundredth of a beat). */
export const moved = (before: Note[], after: Note[]) => after.filter((n, i) => Math.abs(n.start - before[i].start) > 0.01 || Math.abs(n.duration - before[i].duration) > 0.01).length;
