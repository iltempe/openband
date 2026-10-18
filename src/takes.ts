// Takes and comping (F12). Pure: no store, no audio — the commands apply what these return.
import type { Note, Region, Take } from './types';

export interface CompSegment {
  from_beat: number;
  to_beat: number;
  take_id: string;
}

/** Shortest note kept when comping cuts one at a segment boundary (a 64th). */
const MIN_NOTE = 1 / 16;

const cloneNotes = (notes: Note[]) => notes.map((n) => ({ ...n }));

/** The takes of a region; the first time, its current content becomes "Take 1". */
export function withTakes(r: Region, now: number, idFor: () => string): { takes: Take[]; activeTakeId: string } {
  if (r.takes?.length) {
    const active = r.takes.find((t) => t.id === r.activeTakeId) ?? r.takes[r.takes.length - 1];
    // The region holds the active take's current content (the user may have edited it).
    const takes = r.takes.map((t) => (t.id === active.id ? { ...t, notes: cloneNotes(r.notes), audio: r.audio ? { ...r.audio } : undefined } : t));
    return { takes, activeTakeId: active.id };
  }
  const first: Take = { id: idFor(), name: 'Take 1', notes: cloneNotes(r.notes), audio: r.audio ? { ...r.audio } : undefined, createdAt: now, author: 'user' };
  return { takes: [first], activeTakeId: first.id };
}

/** Next free "Take n" name. */
export function nextTakeName(takes: Take[]): string {
  let n = takes.length + 1;
  while (takes.some((t) => t.name === `Take ${n}`)) n++;
  return `Take ${n}`;
}

/** Validate and sort comp segments: inside the region, non-overlapping, known takes. */
export function checkSegments(segments: CompSegment[], takes: Take[], length: number): CompSegment[] {
  if (!segments.length) throw new Error('Give at least one segment');
  const sorted = [...segments].sort((a, b) => a.from_beat - b.from_beat);
  sorted.forEach((s, i) => {
    if (!takes.some((t) => t.id === s.take_id)) throw new Error(`Take "${s.take_id}" not found in this region`);
    if (!(s.to_beat > s.from_beat)) throw new Error('Each segment needs to_beat > from_beat');
    if (s.from_beat < 0 || s.to_beat > length + 1e-9) throw new Error(`Segments must lie inside the region (0–${length} beats)`);
    if (i && s.from_beat < sorted[i - 1].to_beat - 1e-9) throw new Error('Segments overlap');
  });
  return sorted;
}

/**
 * Build the comp: from each segment, the notes of its take that sound inside it, cut at the
 * segment boundaries (a note held across a boundary ends there; one started earlier begins there).
 */
export function compNotes(takes: Take[], segments: CompSegment[], idFor: () => string): Note[] {
  const out: Note[] = [];
  for (const s of segments) {
    const take = takes.find((t) => t.id === s.take_id)!;
    for (const n of take.notes) {
      const start = Math.max(n.start, s.from_beat);
      const end = Math.min(n.start + n.duration, s.to_beat);
      if (end - start < MIN_NOTE - 1e-9) continue;
      out.push({ ...n, id: idFor(), start: +start.toFixed(4), duration: +(end - start).toFixed(4) });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

export interface PassNote extends Note {
  /** Loop pass (0-based) the note was played in. */
  pass: number;
}

/** Cycle recording: one take per loop pass that has notes, positions relative to the loop start. */
export function takesFromPasses(notes: PassNote[], loopStart: number, loopLength: number, now: number, idFor: () => string): Take[] {
  const passes = [...new Set(notes.map((n) => n.pass))].sort((a, b) => a - b);
  return passes.map((p, i) => ({
    id: idFor(),
    name: `Take ${i + 1}`,
    notes: notes
      .filter((n) => n.pass === p)
      .map(({ pass: _, ...n }) => ({ ...n, start: +(n.start - loopStart).toFixed(4), duration: Math.min(n.duration, loopLength - (n.start - loopStart)) }))
      .filter((n) => n.start >= 0 && n.start < loopLength),
    createdAt: now + i,
    author: 'user' as const,
  }));
}

/** Fisher–Yates with an injectable random source (for the blind test). */
export function shuffled<T>(xs: T[], rnd: () => number = Math.random): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
