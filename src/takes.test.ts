import { describe, expect, it } from 'vitest';
import type { Note, Region, Take } from './types';
import { checkSegments, compNotes, nextTakeName, shuffled, takesFromPasses, withTakes } from './takes';

let k = 0;
const id = () => `id${++k}`;
const n = (pitch: number, start: number, duration: number): Note => ({ id: id(), pitch, start, duration, velocity: 0.8 });
const take = (tid: string, notes: Note[]): Take => ({ id: tid, name: tid, notes, createdAt: 0, author: 'ai' });

describe('takes', () => {
  it('turns the current content into Take 1, and keeps edits of the active take', () => {
    const r: Region = { id: 'r', trackId: 't', name: 'Bass', start: 0, length: 4, notes: [n(40, 0, 1)] };
    const a = withTakes(r, 1, id);
    expect(a.takes).toHaveLength(1);
    expect(a.takes[0]).toMatchObject({ name: 'Take 1', author: 'user' });
    expect(a.takes[0].notes[0].pitch).toBe(40);
    const edited: Region = { ...r, notes: [n(43, 0, 2)], takes: [...a.takes, take('t2', [n(50, 0, 1)])], activeTakeId: a.activeTakeId };
    const b = withTakes(edited, 2, id);
    expect(b.takes[0].notes[0].pitch).toBe(43);
    expect(b.takes[1].notes[0].pitch).toBe(50);
    expect(nextTakeName(b.takes)).toBe('Take 3');
  });

  it('comps takes, cutting notes at the segment boundaries', () => {
    const A = take('A', [n(60, 0, 1), n(62, 1.5, 1), n(64, 3, 1)]); // 62 spans the boundary at beat 2
    const B = take('B', [n(70, 0, 4), n(72, 2.5, 0.5), n(74, 1.98, 0.04)]); // 70 starts before the segment
    const segs = checkSegments([{ from_beat: 2, to_beat: 4, take_id: 'B' }, { from_beat: 0, to_beat: 2, take_id: 'A' }], [A, B], 4);
    const notes = compNotes([A, B], segs, id);
    expect(notes.map((x) => [x.pitch, x.start, x.duration])).toEqual([
      [60, 0, 1],
      [62, 1.5, 0.5], // cut at 2
      [70, 2, 2], // begins at 2
      [72, 2.5, 0.5],
    ]);
    // 74 has only 0.02 beats inside B's segment: dropped. A's 64 is outside A's segment.
    expect(new Set(notes.map((x) => x.id)).size).toBe(notes.length);
  });

  it('rejects bad segments', () => {
    const A = take('A', []);
    expect(() => checkSegments([{ from_beat: 0, to_beat: 2, take_id: 'X' }], [A], 4)).toThrow(/not found/);
    expect(() => checkSegments([{ from_beat: 0, to_beat: 3, take_id: 'A' }, { from_beat: 2, to_beat: 4, take_id: 'A' }], [A], 4)).toThrow(/overlap/);
    expect(() => checkSegments([{ from_beat: 0, to_beat: 5, take_id: 'A' }], [A], 4)).toThrow(/inside/);
  });

  it('makes one take per loop pass', () => {
    const notes = [
      { ...n(60, 8, 1), pass: 0 },
      { ...n(62, 9, 1), pass: 0 },
      { ...n(64, 8.5, 1), pass: 2 },
    ];
    const takes = takesFromPasses(notes, 8, 4, 0, id);
    expect(takes.map((t) => t.name)).toEqual(['Take 1', 'Take 2']);
    expect(takes[0].notes.map((x) => x.start)).toEqual([0, 1]);
    expect(takes[1].notes[0]).not.toHaveProperty('pass');
    expect(takes[1].notes[0].start).toBe(0.5);
  });

  it('shuffles without losing items', () => {
    let s = 3;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const out = shuffled(['a', 'b', 'c', 'd'], rnd);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
