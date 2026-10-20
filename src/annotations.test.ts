import { describe, expect, it } from 'vitest';
import type { Annotation, Project } from './types';
import { anchorBeat, checkTarget, matchesTarget, reconcileAnnotations, threads } from './annotations';
import { migrate } from './migrations';
import { emptyProjectFixture, note, region, track } from './__fixtures__/projects';

function song(): Project {
  const p = emptyProjectFixture();
  const t = track('trk_bass');
  p.tracks.push(t);
  p.regions.push(region('rgn_1', t.id, 8, 4, [note(40, 1, 1, 0.8, 'n_a'), note(43, 2, 1, 0.8, 'n_b')]));
  p.sections = [{ id: 'sec_v', name: 'Verse', kind: 'verse', start: 0, length: 16, color: '#fff' }];
  return p;
}
const ann = (id: string, target: Annotation['target'], at: number, extra: Partial<Annotation> = {}): Annotation => ({ id, target, text: id, author: { kind: 'ai', name: 'AI' }, createdAt: at, ...extra });

describe('annotations', () => {
  it('validates targets', () => {
    const p = song();
    expect(checkTarget(p, { type: 'region', id: 'rgn_1' })).toEqual({ type: 'region', id: 'rgn_1' });
    expect(checkTarget(p, { type: 'notes', note_ids: ['n_b'] })).toEqual({ type: 'notes', note_ids: ['n_b'], id: 'rgn_1' });
    expect(() => checkTarget(p, { type: 'region', id: 'nope' })).toThrow(/doesn't exist/);
    expect(() => checkTarget(p, { type: 'range', from_beat: 4, to_beat: 2 })).toThrow(/range/);
    expect(checkTarget(p, undefined)).toEqual({ type: 'project' });
  });

  it('marks annotations orphaned when their target is deleted, without deleting them', () => {
    const p = song();
    p.annotations = [ann('a1', { type: 'region', id: 'rgn_1' }, 1), ann('a2', { type: 'notes', note_ids: ['n_a'], id: 'rgn_1' }, 2), ann('a3', { type: 'section', id: 'sec_v' }, 3)];
    p.regions = [];
    reconcileAnnotations(p);
    expect(p.annotations.map((a) => !!a.orphaned)).toEqual([true, true, false]);
    expect(p.annotations).toHaveLength(3);
    // Undo brings the region back: no longer orphaned.
    const back = song();
    back.annotations = p.annotations;
    reconcileAnnotations(back);
    expect(back.annotations!.some((a) => a.orphaned)).toBe(false);
  });

  it('places pins and groups threads', () => {
    const p = song();
    expect(anchorBeat(p, { type: 'notes', note_ids: ['n_b', 'n_a'] })).toBe(9);
    expect(anchorBeat(p, { type: 'region', id: 'rgn_1' })).toBe(8);
    expect(anchorBeat(p, { type: 'project' })).toBeNull();
    const list = [ann('x', { type: 'region', id: 'rgn_1' }, 1), ann('y', { type: 'section', id: 'sec_v' }, 2), ann('z', { type: 'region', id: 'rgn_1' }, 3, { author: { kind: 'user', name: 'You' }, resolved: true })];
    const th = threads(list);
    expect(th.map((t) => t.items.map((a) => a.id))).toEqual([['x', 'z'], ['y']]);
    expect(th[0].resolved).toBe(false);
    expect(matchesTarget({ type: 'notes', note_ids: ['n_a'], id: 'rgn_1' }, { type: 'region', id: 'rgn_1' })).toBe(true);
    expect(matchesTarget({ type: 'range', from_beat: 0, to_beat: 4 }, { type: 'range', from_beat: 4, to_beat: 8 })).toBe(false);
  });

  it('survive a save and reload', () => {
    const p = song();
    p.annotations = [ann('a1', { type: 'region', id: 'rgn_1' }, 1)];
    const again = migrate(JSON.parse(JSON.stringify(p)));
    expect(again.annotations).toEqual(p.annotations);
  });
});
