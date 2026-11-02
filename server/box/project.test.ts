import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTrack, emptyProject as studioEmpty } from '../../src/store';
import { migrate } from '../../src/migrations';
import { FsStore } from '../store/fs.mjs';
import { SAMPLE_RATE as SR, SessionWriter } from './capture.mjs';
import { audioTrack, emptyProject, importSession, songsOf } from './project.mjs';

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-import-test-'));
  store = new FsStore({ dir: path.join(dir, 'lib'), quota: 1e10 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function session(id = 's1', seconds = 30, extra = {}) {
  const sdir = path.join(dir, id);
  const w = new SessionWriter(sdir, 2);
  w.write(Buffer.alloc(seconds * SR * 6));
  w.close();
  return { dir: sdir, info: { id, channels: 2, startedAt: Date.UTC(2026, 10, 3, 20, 14), endFrame: seconds * SR, cuts: [10 * SR, 20 * SR], marks: [15 * SR], ...extra } };
}
const snapshot = (projectId: string, versionId: string) => JSON.parse(gunzipSync(store.getVersion(projectId, versionId).snapshot).toString());

describe('importing a rehearsal', () => {
  it('builds the same shapes as the studio', () => {
    const shape = (o: object) => Object.keys(o).sort();
    expect(shape(emptyProject('x'))).toEqual(shape(studioEmpty('x')));
    const t = makeTrack(studioEmpty('x'), 'audio', undefined, 'n');
    expect(shape(audioTrack('n'))).toEqual(shape(t));
    const mine = audioTrack('n');
    for (const k of ['kind', 'color', 'volume', 'pan', 'reverb', 'delay', 'mute', 'solo'] as const) expect(mine[k]).toEqual(t[k]);
  });
  it('cuts songs between the cuts', () => {
    expect(songsOf(30, [10, 20])).toEqual([[0, 10], [10, 20], [20, 30]]);
    expect(songsOf(30)).toEqual([[0, 30]]);
    expect(songsOf(30, [0, 99])).toEqual([[0, 30]]);
  });
  it('two channels and three songs: two tracks, three sections, a version on `prove`, main untouched', () => {
    const { dir: d, info } = session();
    const events: { kind: string }[] = [];
    const r = importSession({ store, dir: d, info, names: ['Voce', 'Chitarra'], projectName: 'La band', emit: (e: { kind: string }) => events.push(e) });
    expect(r).toMatchObject({ songs: 3, tracks: 2 });
    expect(store.getProject(r.projectId).value.tracks).toEqual([]);
    expect(store.branches(r.projectId).map((b: { name: string }) => b.name)).toEqual(['prove']);
    expect(store.versionMetas(r.projectId)[0].label).toMatch(/^Prova 2026-11-03 \d\d:14$/);
    const p = migrate(snapshot(r.projectId, r.versionId));
    expect(p.tracks.map((t) => t.name)).toEqual(['Voce', 'Chitarra']);
    expect(p.regions).toHaveLength(6);
    expect(p.sections?.map((s) => s.name)).toEqual(['Brano 1', 'Brano 2', 'Brano 3']);
    const second = p.regions.filter((x) => x.name === 'Brano 2')[0];
    expect(second.audio?.offset).toBe(10);
    expect(second.start).toBeCloseTo((10 * 110) / 60);
    expect(events).toMatchObject([{ kind: 'box_session', songs: 3 }]);
    expect(store.listProjects()[0].box).toEqual({ sessions: 1 });
  });
  it('a MARK is a flub at its moment, and the samples are on the disk', () => {
    const { dir: d, info } = session();
    const r = importSession({ store, dir: d, info });
    const p = snapshot(r.projectId, r.versionId);
    expect(p.flubs[0].beat).toBeCloseTo((15 * 110) / 60);
    const sid = p.regions[0].audio.sampleId;
    expect(store.sampleFile(sid).bytes).toBe(44 + 30 * SR * 3);
  });
  it('the next rehearsal builds on the last, after it', () => {
    const one = session('s1');
    const r1 = importSession({ store, dir: one.dir, info: one.info });
    const two = session('s2', 20, { cuts: [] });
    const r2 = importSession({ store, dir: two.dir, info: two.info, projectId: r1.projectId });
    const p = snapshot(r2.projectId, r2.versionId);
    expect(p.rehearsals.map((x: { id: string }) => x.id)).toEqual(['s1', 's2']);
    expect(p.tracks).toHaveLength(4);
    const last = Math.max(...p.regions.filter((x: { trackId: string }) => x.trackId === p.tracks[0].id).map((x: { start: number; length: number }) => x.start + x.length));
    expect(p.regions.find((x: { trackId: string }) => x.trackId === p.tracks[2].id).start).toBeGreaterThan(last);
    expect(store.versionMetas(r2.projectId).at(-1).parentIds).toEqual([r1.versionId]);
  });
  it('importing a session twice does nothing', () => {
    const { dir: d, info } = session();
    const r1 = importSession({ store, dir: d, info });
    expect(importSession({ store, dir: d, info, projectId: r1.projectId })).toMatchObject({ already: true, versionId: r1.versionId });
    expect(store.versionMetas(r1.projectId)).toHaveLength(1);
  });
});
