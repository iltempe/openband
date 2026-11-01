import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import { MemoryBackend, ConflictError } from './memory';
import { localProjects, readAutosave } from './local';
import { backend, setBackend } from '.';

const song = (id: string, name = 'S'): Project => ({ version: 3, name, bpm: 100, key: 'C', tracks: [], regions: [], loop: { enabled: false, start: 0, end: 16 }, masterVolume: 0.8, metronome: false, meta: { projectId: id, createdAt: 1, updatedAt: 2 } });

describe('MemoryBackend', () => {
  it('lists, gets, trashes and refuses a stale etag', async () => {
    const b = MemoryBackend();
    const { etag } = await b.projects.put(song('a'));
    expect((await b.projects.list()).map((s) => s.id)).toEqual(['a']);
    const second = await b.projects.put(song('a', 'S2'), etag);
    await expect(b.projects.put(song('a', 'late'), etag)).rejects.toBeInstanceOf(ConflictError);
    const got = await b.projects.get('a');
    expect(got).toMatchObject({ etag: second.etag, value: { name: 'S2' } });
    await b.projects.trash('a');
    expect(await b.projects.get('a')).toBeNull();
    expect(b.trashed.has('a')).toBe(true);
  });
  it('keeps versions, branches and samples by project', async () => {
    const b = MemoryBackend();
    await b.versions.put({ id: 'v1', projectId: 'a', parentIds: [], branch: 'main', label: '', createdAt: 1, author: 'user', snapshot: new Uint8Array(1) });
    await b.versions.putBranch({ id: 'a:main', projectId: 'a', name: 'main', headId: 'v1' });
    expect(await b.versions.list('b')).toEqual([]);
    expect((await b.versions.branches('a'))[0].headId).toBe('v1');
    await b.samples.put('s', new ArrayBuffer(4), 'n', 'audio/wav');
    expect(await b.samples.has('s')).toBe(true);
    expect((await b.samples.get('s'))?.data.byteLength).toBe(4);
  });
  it('is what backend() returns once set', () => {
    const before = backend();
    const b = MemoryBackend();
    setBackend(b);
    expect(backend()).toBe(b);
    setBackend(before);
  });
});

describe('the local project slot', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  });
  it('writes synchronously, under the same key as ever', () => {
    void localProjects.put(song('a'));
    expect(JSON.parse(localStorage.getItem('openband.project.v2')!).meta.projectId).toBe('a');
    expect(readAutosave()?.name).toBe('S');
  });
  it('still reads the 0.1 autosave key', () => {
    localStorage.setItem('openband.project.v1', JSON.stringify(song('old')));
    expect(readAutosave()?.meta?.projectId).toBe('old');
  });
  it('gets and trashes only the song in the slot', async () => {
    await localProjects.put(song('a'));
    expect(await localProjects.get('b')).toBeNull();
    await localProjects.trash('b');
    expect((await localProjects.get('a'))?.value.name).toBe('S');
    await localProjects.trash('a');
    expect(readAutosave()).toBeNull();
  });
});
