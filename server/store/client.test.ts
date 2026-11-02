import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsStore } from './fs.mjs';
import { createStoreApi } from './api.mjs';
import { Pairing } from '../pairing.mjs';
import type { Project } from '../../src/types';
import { MemoryBackend } from '../../src/storage/memory';
import { ServerBackend, type Kv } from '../../src/storage/server';

const song = (id: string, name = 'S', extra: Partial<Project> = {}): Project => ({ version: 3, name, bpm: 100, key: 'C', tracks: [], regions: [], loop: { enabled: false, start: 0, end: 16 }, masterVolume: 0.8, metronome: false, meta: { projectId: id, createdAt: 1, updatedAt: 2 }, ...extra });
const memoryKv = (): Kv => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

let dir: string;
let srv: http.Server;
let url: string;
let store: FsStore;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-client-'));
  store = new FsStore({ dir, quota: 1e8 });
  const api = createStoreApi({ store, pairing: new Pairing() });
  srv = http.createServer(async (req, res) => {
    if (!(await api.handleHttp(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterEach(async () => {
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function client(opts: { onConflict?: (p: Project, etag: string) => void; online?: { value: boolean }; kv?: Kv; cache?: ReturnType<typeof MemoryBackend> } = {}) {
  const cache = opts.cache ?? MemoryBackend();
  const b = new ServerBackend({
    url,
    cache,
    kv: opts.kv ?? memoryKv(),
    onConflict: opts.onConflict,
    fetch: ((...a: Parameters<typeof fetch>) => (opts.online?.value === false ? Promise.reject(new Error('offline')) : fetch(...a))) as typeof fetch,
  });
  return { b, cache };
}

describe('ServerBackend', () => {
  it('leaves a song that is not on the server alone', async () => {
    const { b, cache } = client();
    await b.projects.put(song('a'));
    expect(store.getProject('a')).toBeNull();
    expect((await cache.projects.get('a'))?.value.name).toBe('S');
  });
  it('adopts a song with its versions, branches and samples, and the audio is on the disk', async () => {
    const { b, cache } = client();
    const withAudio = song('a', 'S', { regions: [{ id: 'r', trackId: 't', start: 0, length: 4, notes: [], audio: { sampleId: 'smp_1' } }] as never });
    await cache.samples.put('smp_1', new Uint8Array([9, 8, 7]).buffer, 'take.wav', 'audio/wav');
    await cache.versions.put({ id: 'v1', projectId: 'a', parentIds: [], branch: 'main', label: 'one', createdAt: 1, author: 'user', snapshot: new Uint8Array([1, 2, 3, 200]) });
    await cache.versions.putBranch({ id: 'a:main', projectId: 'a', name: 'main', headId: 'v1' });
    await b.adopt(withAudio);
    expect(store.getProject('a')?.value.name).toBe('S');
    expect([...store.getVersion('a', 'v1').snapshot]).toEqual([1, 2, 3, 200]);
    expect(store.branches('a')[0].headId).toBe('v1');
    expect(store.sampleFile('smp_1').bytes).toBe(3);
    expect(b.status().state).toBe('ready');
  });
  it('asks only for what is missing: a sample known to the server is not sent again', async () => {
    let puts = 0;
    const { b, cache } = client();
    const orig = b.req.bind(b);
    b.req = (p, i) => (i?.method === 'PUT' && p.startsWith('/samples') && puts++, orig(p, i));
    store.putSample('smp_1', Buffer.from([1]), 'x', 'audio/wav');
    await cache.samples.put('smp_1', new ArrayBuffer(1), 'x', 'audio/wav');
    await b.adopt(song('a', 'S', { regions: [{ id: 'r', trackId: 't', start: 0, length: 4, notes: [], audio: { sampleId: 'smp_1' } }] as never }));
    expect(puts).toBe(0);
  });
  it('a second device gets the samples and history on demand', async () => {
    const one = client();
    await one.cache.versions.put({ id: 'v1', projectId: 'a', parentIds: [], branch: 'main', label: 'one', createdAt: 1, author: 'user', snapshot: new Uint8Array([5]) });
    await one.b.adopt(song('a'));
    store.putSample('smp_1', Buffer.from([1, 2]), 'x.wav', 'audio/wav');
    const two = client();
    expect((await two.b.projects.list()).map((p) => p.id)).toEqual(['a']);
    await two.b.pull('a');
    expect((await two.cache.versions.get('v1'))?.snapshot).toEqual(new Uint8Array([5]));
    expect((await two.b.samples.get('smp_1'))?.data.byteLength).toBe(2);
    expect(await two.cache.samples.has('smp_1')).toBe(true);
  });
  it('concurrent edits: the second writer is told, keeps its song, and the server keeps the first', async () => {
    const mine: Project[] = [];
    const one = client();
    await one.b.adopt(song('a'));
    const two = client({ onConflict: (p) => mine.push(p) });
    await two.b.projects.get('a');
    await one.b.projects.put(song('a', 'first'));
    await two.b.projects.put(song('a', 'second'));
    expect(store.getProject('a')?.value.name).toBe('first');
    expect(mine.map((p) => p.name)).toEqual(['second']);
    expect(two.b.status().state).toBe('conflict');
    const fresh = await two.b.projects.get('a');
    two.b.resolved('a', fresh!.etag);
    expect(two.b.status().state).toBe('ready');
    await two.b.projects.put(song('a', 'third'));
    expect(store.getProject('a')?.value.name).toBe('third');
  });
  it('offline work waits in the outbox, survives a reload and arrives', async () => {
    const online = { value: true };
    const kv = memoryKv();
    const cache = MemoryBackend();
    const { b } = client({ online, kv, cache });
    await b.adopt(song('a'));
    online.value = false;
    await b.projects.put(song('a', 'on the train'));
    await b.versions.put({ id: 'v2', projectId: 'a', parentIds: [], branch: 'main', label: 'x', createdAt: 2, author: 'user', snapshot: new Uint8Array([1]) });
    expect(b.status().state).toBe('offline');
    expect(b.pending()).toBe(2);
    expect(store.getProject('a')?.value.name).toBe('S');
    const again = client({ online, kv, cache }).b;
    expect(again.pending()).toBe(2);
    online.value = true;
    await again.flush();
    expect(store.getProject('a')?.value.name).toBe('on the train');
    expect(store.getVersion('a', 'v2')).toBeTruthy();
    expect(again.status().state).toBe('ready');
  });
  it('offline, the list and the song come from what is known', async () => {
    const online = { value: true };
    const { b } = client({ online });
    await b.projects.put(song('a'));
    await b.adopt(song('a'));
    await b.projects.list();
    online.value = false;
    expect((await b.projects.list()).map((p) => p.id)).toEqual(['a']);
    expect((await b.projects.get('a'))?.value.name).toBe('S');
  });
  it('labels its writes, so a page can tell its own events from another device\'s', async () => {
    const seen: (string | undefined)[] = [];
    const orig = fetch;
    const b = new ServerBackend({ url, cache: MemoryBackend(), kv: memoryKv(), client: 'page-1', fetch: ((u: string, i: RequestInit) => (seen.push((i.headers as Record<string, string>)['x-openband-client']), orig(u, i))) as typeof fetch });
    await b.adopt(song('a'));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['page-1']));
  });
  it('a song adopted twice, by a save and by the first-run copy, is no conflict', async () => {
    const conflicts: Project[] = [];
    const { b } = client({ onConflict: (p) => conflicts.push(p) });
    await b.adopt(song('a'));
    await b.adopt(song('a', 'older copy'));
    expect(conflicts).toEqual([]);
    expect(b.status().state).toBe('ready');
    expect(store.getProject('a')?.value.name).toBe('S');
  });
  it('forgetting a song stops sending it and leaves the server copy', async () => {
    const { b } = client();
    await b.adopt(song('a'));
    b.forget('a');
    await b.projects.put(song('a', 'only here'));
    expect(store.getProject('a')?.value.name).toBe('S');
  });
});
