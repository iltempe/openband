import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { canonicalJSON } from './canonical';
import { diffNotes, diffProjects } from './diff';
import { commonAncestor, mergeProjects } from './merge';
import { emptyProjectFixture, note, region, track } from '../__fixtures__/projects';

function base(): Project {
  const p = emptyProjectFixture();
  p.bpm = 82;
  p.tracks = [track('t_bass', { name: 'Bass', instrument: 'finger-bass' }), track('t_keys', { name: 'Keys' })];
  p.regions = [
    region('r_bass', 't_bass', 0, 8, [note(40, 0, 1, 0.8, 'b1'), note(43, 2, 1, 0.8, 'b2'), note(45, 4, 1, 0.8, 'b3')]),
    region('r_keys', 't_keys', 0, 8, [note(60, 0, 2, 0.8, 'k1')]),
  ];
  p.sections = [{ id: 's_ch', name: 'Chorus', kind: 'chorus', start: 0, length: 16 }];
  return p;
}
const clone = (p: Project) => structuredClone(p);

describe('canonical JSON', () => {
  it('is stable and independent of insertion order', () => {
    const a = base();
    const b = clone(a);
    b.regions.reverse();
    b.regions[1].notes.reverse();
    b.regions[0].notes = [...b.regions[0].notes];
    // Same values, keys in another order and float noise.
    b.regions[0] = Object.fromEntries(Object.entries(b.regions[0]).reverse()) as typeof b.regions[0];
    b.bpm = 82.000001;
    expect(canonicalJSON(b)).toBe(canonicalJSON(a));
    expect(canonicalJSON(a)).toBe(canonicalJSON(clone(a)));
    const c = clone(a);
    c.bpm = 86;
    expect(canonicalJSON(c)).not.toBe(canonicalJSON(a));
  });
});

describe('diff', () => {
  it('reports project, track, region, note and section changes', () => {
    const a = base();
    const b = clone(a);
    b.bpm = 86;
    b.tracks[0].volume = 0.6;
    b.tracks.push(track('t_pad', { name: 'Pad' }));
    b.tracks = b.tracks.filter((t) => t.id !== 't_keys');
    b.regions = b.regions.filter((r) => r.trackId !== 't_keys');
    const r = b.regions[0];
    r.start = 8; // moved
    r.notes[0].pitch = 41; // changed (same id)
    r.notes.push(note(47, 6, 1, 0.8, 'b4')); // added
    r.notes = r.notes.filter((n) => n.id !== 'b3'); // removed
    b.regions.push(region('r_pad', 't_pad', 0, 4, []));
    b.sections![0].length = 8;
    const d = diffProjects(a, b);
    expect(d.project.bpm).toEqual({ from: 82, to: 86 });
    expect(d.tracks.added.map((t) => t.id)).toEqual(['t_pad']);
    expect(d.tracks.removed.map((t) => t.id)).toEqual(['t_keys']);
    expect(d.tracks.changed[0]).toMatchObject({ id: 't_bass', fields: { volume: { from: 0.8, to: 0.6 } } });
    expect(d.regions.added.map((x) => x.id)).toEqual(['r_pad']);
    expect(d.regions.removed.map((x) => x.id)).toEqual(['r_keys']);
    const rc = d.regions.changed[0];
    expect(rc.moved).toBe(true);
    expect(rc.notes!.added.map((n) => n.id)).toEqual(['b4']);
    expect(rc.notes!.removed.map((n) => n.id)).toEqual(['b3']);
    expect(rc.notes!.changed.map((n) => n.id)).toEqual(['b1']);
    expect(d.sections.changed[0].fields.length).toEqual({ from: 16, to: 8 });
    expect(d.summary).toContain('tempo 82→86');
    expect(d.summary.some((s) => s.startsWith('Bass: 3 notes changed'))).toBe(true);
    expect(diffProjects(a, clone(a)).identical).toBe(true);
  });

  it('matches notes without ids by pitch and start (1/32 tolerance)', () => {
    const d = diffNotes([note(60, 1, 1, 0.8, 'x'), note(62, 2, 1, 0.8, 'y')], [note(60, 1.02, 1, 0.8, 'other'), note(64, 3, 1, 0.8, 'z')]);
    expect(d.changed.map((c) => c.id)).toEqual(['x']); // moved by 0.02 beats: same note, changed
    expect(d.removed.map((n) => n.id)).toEqual(['y']);
    expect(d.added.map((n) => n.id)).toEqual(['z']);
  });
});

describe('three-way merge', () => {
  it('takes non-conflicting changes from both sides', () => {
    const o = base();
    const a = clone(o);
    const b = clone(o);
    a.tracks[0].volume = 0.5; // ours: bass volume
    b.tracks[0].pan = -0.3; // theirs: bass pan (same track, other field)
    b.bpm = 90; // theirs only
    b.regions[1].notes.push(note(64, 2, 1, 0.8, 'k2')); // theirs: keys region
    a.regions[0].start = 4; // ours: bass region
    const m = mergeProjects(o, a, b, 'manual');
    expect(m.conflicts).toEqual([]);
    expect(m.project.bpm).toBe(90);
    expect(m.project.tracks[0]).toMatchObject({ volume: 0.5, pan: -0.3 });
    expect(m.project.regions.find((r) => r.id === 'r_keys')!.notes).toHaveLength(2);
    expect(m.project.regions.find((r) => r.id === 'r_bass')!.start).toBe(4);
  });

  it('reports conflicts and resolves them by strategy or pick', () => {
    const o = base();
    const a = clone(o);
    const b = clone(o);
    a.bpm = 84;
    b.bpm = 88;
    a.regions[0].notes[0].pitch = 41;
    b.regions[0].notes[0].pitch = 38;
    const manual = mergeProjects(o, a, b, 'manual');
    expect(manual.conflicts.map((c) => `${c.entity}:${c.id}`).sort()).toEqual(['project:bpm', 'region:r_bass']);
    expect(manual.project.bpm).toBe(84); // ours kept until resolved
    expect(mergeProjects(o, a, b, 'theirs').project.bpm).toBe(88);
    expect(mergeProjects(o, a, b, 'ours').project.regions[0].notes[0].pitch).toBe(41);
    // "Take the bass from version B", keep our tempo.
    const picked = mergeProjects(o, a, b, 'manual', [{ entity: 'region', id: 'r_bass', from: 'b' }, { entity: 'project', id: 'bpm', from: 'a' }]);
    expect(picked.conflicts).toEqual([]);
    expect(picked.project.regions[0].notes[0].pitch).toBe(38);
    expect(picked.project.bpm).toBe(84);
  });

  it('handles deletions: deleted on one side and untouched on the other → deleted; deleted vs changed → conflict', () => {
    const o = base();
    const a = clone(o);
    const b = clone(o);
    b.regions = b.regions.filter((r) => r.id !== 'r_keys'); // theirs deletes keys region
    const m = mergeProjects(o, a, b);
    expect(m.project.regions.map((r) => r.id)).toEqual(['r_bass']);
    a.regions[1].notes[0].pitch = 62; // now ours changed it
    const m2 = mergeProjects(o, a, b);
    expect(m2.conflicts.map((c) => c.id)).toEqual(['r_keys']);
    // Regions of a removed track are dropped.
    const c = clone(o);
    c.tracks = c.tracks.filter((t) => t.id !== 't_keys');
    expect(mergeProjects(o, clone(o), c).project.regions.map((r) => r.id)).toEqual(['r_bass']);
  });

  it('finds the common ancestor', () => {
    const parents = new Map([
      ['v1', []],
      ['v2', ['v1']],
      ['v3', ['v2']],
      ['b1', ['v2']],
      ['b2', ['b1']],
    ]);
    expect(commonAncestor(parents, 'v3', 'b2')).toBe('v2');
    expect(commonAncestor(parents, 'v3', 'v3')).toBe('v3');
  });
});
