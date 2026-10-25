import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { gzipSync, strToU8 } from 'fflate';
import type { Annotation, Project } from '../types';
import { readProject, writeProject } from './binding';
import { publishBranches, publishVersions, roomBranches, roomVersions, type SharedVersion } from './shared';
import { emptyProjectFixture, region, track } from '../__fixtures__/projects';
import { migrate } from '../migrations';

const version = (id: string, by: string, at: number, label = id): SharedVersion => ({ id, projectId: 'song_1', parentIds: [], branch: 'main', label, createdAt: at, author: 'user', by, snapshot: gzipSync(strToU8(JSON.stringify({ label })), { mtime: 0 }) });
/** Two peers that were in sync, then each works offline; finally they exchange what they did. */
function offlinePair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const exchange = () => {
    const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, ua, 'remote');
    Y.applyUpdate(a, ub, 'remote');
  };
  return { a, b, exchange };
}

function song(): Project {
  const p = emptyProjectFixture();
  p.tracks = [track('t_bass', { name: 'Bass' })];
  p.regions = [region('r1', 't_bass', 0, 8, [])];
  return p;
}
const ann = (id: string, text: string, author: Annotation['author'], at: number, extra: Partial<Annotation> = {}): Annotation => ({ id, target: { type: 'region', id: 'r1' }, text, author, createdAt: at, ...extra });

describe('versions and comments shared in a room (F16)', () => {
  it('versions saved at the same time by two people are both kept, identical on both sides', () => {
    const { a, b, exchange } = offlinePair();
    publishVersions(a, [version('ver_a1', 'Alice', 100), version('ver_a2', 'Alice', 300)]);
    publishVersions(b, [version('ver_b1', 'Bob', 200)]);
    exchange();
    const ids = (d: Y.Doc) => roomVersions(d, 'song_1').map((v) => `${v.id}:${v.by}`);
    expect(ids(a)).toEqual(['ver_a1:Alice', 'ver_b1:Bob', 'ver_a2:Alice']);
    expect(ids(b)).toEqual(ids(a));
    // Snapshots arrive intact; republishing changes nothing.
    expect(roomVersions(b)[0].snapshot).toEqual(version('ver_a1', 'Alice', 100).snapshot);
    expect(publishVersions(a, [version('ver_b1', 'Bob', 200)])).toBe(0);
  });

  it('when two people move a branch head at once, the newest move wins everywhere', () => {
    // Yjs settles concurrent writes of one key by client id: try many pairs so luck can't pass it.
    for (let round = 0; round < 20; round++) {
      const pair = offlinePair();
      publishBranches(pair.a, [{ id: 'song_1:main', projectId: 'song_1', name: 'main', headId: 'ver_new', at: 200 }]);
      publishBranches(pair.b, [{ id: 'song_1:main', projectId: 'song_1', name: 'main', headId: 'ver_old', at: 100 }]);
      pair.exchange();
      for (const d of [pair.a, pair.b]) expect(roomBranches(d, 'song_1')[0].headId).toBe('ver_new');
    }
    const { a, b, exchange } = offlinePair();
    publishBranches(a, [{ id: 'song_1:main', projectId: 'song_1', name: 'main', headId: 'ver_a1', at: 100, by: 'Alice' }]);
    publishBranches(b, [{ id: 'song_1:main', projectId: 'song_1', name: 'main', headId: 'ver_b1', at: 200, by: 'Bob' }]);
    publishBranches(b, [{ id: 'song_1:idea', projectId: 'song_1', name: 'idea', headId: 'ver_b1', at: 150, by: 'Bob' }]);
    exchange();
    for (const d of [a, b]) expect(roomBranches(d, 'song_1').map((x) => `${x.name}→${x.headId}`)).toEqual(['idea→ver_b1', 'main→ver_b1']);
    // An older move arriving later doesn't win.
    expect(publishBranches(a, [{ id: 'song_1:main', projectId: 'song_1', name: 'main', headId: 'ver_old', at: 50 }])).toBe(0);
  });

  it('comments from several people and the AI converge, with their authors and replies', () => {
    const { a, b, exchange } = offlinePair();
    const base = song();
    base.annotations = [ann('ann_1', 'Why this bass?', { kind: 'user', name: 'Alice' }, 1)];
    writeProject(a, base, 'A');
    exchange();
    // Offline, concurrently: Bob's AI answers, Alice resolves her question, Carla adds a comment.
    const pb = readProject(b, base);
    pb.annotations = [...pb.annotations!, ann('ann_2', 'It walks the chord tones.', { kind: 'ai', name: 'AI · Bob' }, 2, { replyTo: 'ann_1' })];
    writeProject(b, pb, 'B');
    const pa = readProject(a, base);
    pa.annotations = [{ ...pa.annotations![0], resolved: true }, ann('ann_3', 'Love the fill', { kind: 'user', name: 'Carla' }, 3)];
    writeProject(a, pa, 'A');
    exchange();
    const fa = readProject(a, base).annotations!;
    const fb = readProject(b, base).annotations!;
    expect(fb).toEqual(fa);
    expect(fa.map((x) => [x.id, x.author.name, x.replyTo ?? null, !!x.resolved])).toEqual([
      ['ann_1', 'Alice', null, true],
      ['ann_2', 'AI · Bob', 'ann_1', false],
      ['ann_3', 'Carla', null, false],
    ]);
  });

  it('old songs: comment authors become {kind, name}', () => {
    const p = { ...song(), version: 2, annotations: [{ id: 'x', target: { type: 'project' }, text: 'hi', author: 'ai', createdAt: 1 }, { id: 'y', target: { type: 'project' }, text: 'yo', author: 'user', createdAt: 2 }] };
    expect(migrate(p).annotations!.map((x) => x.author)).toEqual([{ kind: 'ai', name: 'AI' }, { kind: 'user', name: 'You' }]);
  });
});
