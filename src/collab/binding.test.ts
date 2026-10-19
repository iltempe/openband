import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Project } from '../types';
import { readProject, undoManagerFor, writeProject } from './binding';
import { emptyProjectFixture, note, region, track } from '../__fixtures__/projects';

function song(): Project {
  const p = emptyProjectFixture();
  p.tracks = [track('t_bass', { name: 'Bass' }), track('t_keys', { name: 'Keys' })];
  p.regions = [region('r1', 't_bass', 0, 8, [note(40, 0, 1, 0.8, 'a'), note(43, 2, 1, 0.8, 'b')]), region('r2', 't_keys', 0, 8, [note(60, 0, 2, 0.8, 'k')])];
  p.sections = [{ id: 's1', name: 'Verse', kind: 'verse', start: 0, length: 16 }];
  return p;
}

/** Two peers connected in memory: every update of one is applied to the other. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'));
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'));
  return { a, b };
}

const strip = (p: Project) => JSON.parse(JSON.stringify(p));

describe('collab binding', () => {
  it('round-trips a song through a Y.Doc', () => {
    const d = new Y.Doc();
    const p = song();
    writeProject(d, p, 'me');
    expect(strip(readProject(d, p))).toEqual(strip(p));
  });

  it('converges when two people edit different notes of the same region at the same time', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const base = song();
    writeProject(a, base, 'A');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // Offline, concurrently:
    const pa = readProject(a, base);
    pa.regions[0].notes[0].pitch = 41; // A changes note a
    pa.regions[0].notes.push(note(45, 4, 1, 0.8, 'c')); // and adds c
    writeProject(a, pa, 'A');
    const pb = readProject(b, base);
    pb.regions[0].notes[1].velocity = 0.5; // B changes note b
    pb.tracks[1].volume = 0.4; // and a track field
    writeProject(b, pb, 'B');
    // Exchange.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    const ra = strip(readProject(a, base));
    const rb = strip(readProject(b, base));
    expect(ra).toEqual(rb);
    const notes = ra.regions[0].notes;
    expect(notes.find((n: { id: string }) => n.id === 'a').pitch).toBe(41);
    expect(notes.find((n: { id: string }) => n.id === 'b').velocity).toBe(0.5);
    expect(notes.map((n: { id: string }) => n.id)).toContain('c');
    expect(ra.tracks[1].volume).toBe(0.4);
  });

  it("undo only takes back your own changes, not the other person's", () => {
    const { a, b } = pair();
    const base = song();
    writeProject(a, base, 'A');
    const undoA = undoManagerFor(a, 'A', 0);
    const undoB = undoManagerFor(b, 'B', 0);
    // A transposes the bass, then B changes the keys.
    const p1 = readProject(a, base);
    p1.regions[0].notes = p1.regions[0].notes.map((n) => ({ ...n, pitch: n.pitch + 2 }));
    writeProject(a, p1, 'A');
    const p2 = readProject(b, base);
    p2.regions[1].notes[0].pitch = 64;
    p2.bpm = 100;
    writeProject(b, p2, 'B');
    undoA.undo();
    const ra = readProject(a, base);
    const rb = readProject(b, base);
    expect(strip(ra)).toEqual(strip(rb));
    expect(ra.regions[0].notes.map((n) => n.pitch)).toEqual([40, 43]); // A's change undone
    expect(ra.regions[1].notes[0].pitch).toBe(64); // B's change kept
    expect(ra.bpm).toBe(100);
    undoB.undo();
    expect(readProject(a, base).bpm).toBe(base.bpm);
  });

  it('only writes what changed', () => {
    const d = new Y.Doc();
    const p = song();
    writeProject(d, p, 'me');
    let updates = 0;
    d.on('update', () => updates++);
    writeProject(d, structuredClone(p), 'me');
    expect(updates).toBe(0);
    const q = structuredClone(p);
    q.regions[0].notes[0].velocity = 0.3;
    writeProject(d, q, 'me');
    expect(updates).toBe(1);
  });
});
