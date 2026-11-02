import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { canonicalJSON as clientCanonical } from '../../src/versions/canonical';
import { canonicalJSON } from './canonical.mjs';
import { FsStore, StoreError, etagOf, safeId } from './fs.mjs';
import { createStoreApi, isLocalRequest, PREFIX } from './api.mjs';
import { RateLimit } from './cassettes.mjs';
import { Pairing } from '../pairing.mjs';
import * as Y from 'yjs';
import { readProject, writeProject } from '../../src/collab/binding';
import { persistRoom, readRoomProject } from './room.mjs';

const song = (id: string, name = 'S') => ({ version: 3, name, bpm: 100, key: 'C', tracks: [{ id: 't', automation: [{ target: { kind: 'fx', unit: 'eq', param: 'low' }, points: [{ beat: 2, value: 0.123456 }, { beat: 1, value: 1 }] }, { target: { kind: 'mix', param: 'volume' }, points: [] }] }], regions: [{ id: 'r', trackId: 't', start: 0.33333, length: 4, notes: [{ id: 'b', start: 1, pitch: 60 }, { id: 'a', start: 0, pitch: 62 }] }], loop: { enabled: false, start: 0, end: 16 }, masterVolume: 0.8, metronome: false, meta: { projectId: id, createdAt: 1, updatedAt: 2 } });

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-store-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('FsStore', () => {
  it('gives the same canonical string as the studio, so the etags agree', () => {
    expect(canonicalJSON(song('a'))).toBe(clientCanonical(song('a') as never));
  });
  it('refuses ids that leave the folder', () => {
    for (const bad of ['../x', '..', '.hidden', 'a/b', '', 'a\\b']) expect(() => safeId(bad)).toThrow(StoreError);
    expect(safeId('song_abc-1')).toBe('song_abc-1');
  });
  it('creates, then needs If-Match; a stale etag is a 409 and changes nothing', () => {
    const s = new FsStore({ dir, quota: 1e9 });
    const { etag } = s.putProject('a', song('a'));
    expect(etag).toBe(etagOf(song('a')));
    expect(() => s.putProject('a', song('a', 'x'))).toThrow(expect.objectContaining({ status: 428 }));
    const next = s.putProject('a', song('a', 'two'), etag);
    expect(() => s.putProject('a', song('a', 'late'), etag)).toThrow(expect.objectContaining({ status: 409, etag: next.etag }));
    expect(s.getProject('a')).toMatchObject({ etag: next.etag, value: { name: 'two' } });
    expect(s.listProjects()[0]).toMatchObject({ id: 'a', name: 'two', source: 'server', versions: 0 });
  });
  it('a crash before the rename leaves the old file whole, and the leftover is swept', () => {
    const s = new FsStore({ dir, quota: 1e9 });
    const { etag } = s.putProject('a', song('a', 'good'));
    let crash = true;
    const c = new FsStore({ dir, quota: 1e9, beforeRename: () => { if (crash) throw new Error('power cut'); } });
    expect(() => c.putProject('a', song('a', 'half'), etag)).toThrow('power cut');
    crash = false;
    expect(c.getProject('a')?.value.name).toBe('good');
    const pdir = path.join(dir, 'projects', 'a');
    expect(fs.readdirSync(pdir).some((f) => f.endsWith('.tmp'))).toBe(true);
    new FsStore({ dir, quota: 1e9 });
    expect(fs.readdirSync(pdir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
  it('versions are append-only and keep their exact bytes', () => {
    const s = new FsStore({ dir, quota: 1e9 });
    s.putProject('a', song('a'));
    const snapshot = new Uint8Array(gzipSync(JSON.stringify(song('a'))));
    const v = { id: 'v1', projectId: 'a', parentIds: [], branch: 'main', label: 'x', createdAt: 1, author: 'user', snapshot };
    s.putVersion('a', v);
    s.putVersion('a', v);
    expect(() => s.putVersion('a', { ...v, snapshot: new Uint8Array([1]) })).toThrow(expect.objectContaining({ status: 409 }));
    expect(Buffer.compare(s.getVersion('a', 'v1').snapshot, Buffer.from(snapshot))).toBe(0);
    expect(fs.existsSync(path.join(dir, 'projects/a/versions/v1.json.gz'))).toBe(true);
    expect(JSON.parse(gunzipSync(s.getVersion('a', 'v1').snapshot).toString()).name).toBe('S');
  });
  it('the newest branch move wins', () => {
    const s = new FsStore({ dir, quota: 1e9 });
    s.putProject('a', song('a'));
    const b = { id: 'a:main', projectId: 'a', name: 'main', headId: 'v2', at: 5 };
    s.putBranch('a', b);
    s.putBranch('a', { ...b, headId: 'old', at: 1 });
    expect(s.branches('a')).toEqual([b]);
  });
  it('the journal appends a batch and compacts', () => {
    const s = new FsStore({ dir, quota: 1e9 });
    s.appendJournal('a', [{ id: 'e2', seq: 2, projectId: 'a' }, { id: 'e1', seq: 1, projectId: 'a' }]);
    expect(s.journal('a').map((e: { id: string }) => e.id)).toEqual(['e1', 'e2']);
    s.appendJournal('a', [], ['e1']);
    expect(s.journal('a').map((e: { id: string }) => e.id)).toEqual(['e2']);
  });
  it('stops at the quota with a 507', () => {
    const s = new FsStore({ dir, quota: 100 });
    expect(() => s.putSample('smp_x', Buffer.alloc(200), 'n', 'audio/wav')).toThrow(expect.objectContaining({ status: 507 }));
    s.putSample('smp_y', Buffer.alloc(10), 'n', 'audio/wav');
    expect(s.sampleFile('smp_y').file.endsWith('.wav')).toBe(true);
  });
  it('trash keeps a song 30 days, then frees it and its samples, not the shared ones', () => {
    let t = 1000;
    const now = () => t;
    const s = new FsStore({ dir, quota: 1e9, now });
    const withSample = (id: string, sampleId: string) => ({ ...song(id), regions: [{ id: 'r', trackId: 't', start: 0, length: 1, notes: [], audio: { sampleId } }] });
    s.putProject('a', withSample('a', 'smp_only'));
    s.putProject('b', withSample('b', 'smp_shared'));
    s.putVersion('a', { id: 'v', projectId: 'a', parentIds: [], branch: 'main', label: '', createdAt: 1, author: 'user', snapshot: gzipSync(JSON.stringify(withSample('a', 'smp_shared'))) });
    s.putSample('smp_only', Buffer.alloc(4), 'n', 'audio/wav');
    s.putSample('smp_shared', Buffer.alloc(4), 'n', 'audio/wav');
    s.trashProject('a');
    expect(s.getProject('a')).toBeNull();
    expect(s.purgeTrash()).toBe(0);
    expect(s.sampleMeta('smp_only')).toBeTruthy();
    t += 31 * 86400_000;
    expect(s.purgeTrash()).toBe(1);
    expect(s.sampleMeta('smp_only')).toBeNull();
    expect(s.sampleMeta('smp_shared')).toBeTruthy();
  });
});

describe('rooms', () => {
  const roomDoc = () => {
    const doc = new Y.Doc();
    writeProject(doc, song('a', 'In the room') as never, 'x');
    return doc;
  };
  it('reads the same song as the studio does', () => {
    const doc = roomDoc();
    expect(canonicalJSON(readRoomProject(doc))).toBe(clientCanonical(readProject(doc) as never));
  });
  it('keeps versions and heads, and the song when asked, in spite of a stale etag', () => {
    const store = new FsStore({ dir, quota: 1e9 });
    store.putProject('a', song('a', 'old'));
    const doc = roomDoc();
    doc.getMap('versions').set('v1', { id: 'v1', projectId: 'a', parentIds: [], branch: 'main', label: 'x', createdAt: 1, author: 'user', snapshot: gzipSync('{}') });
    doc.getMap('branches').set('a:main@me', { id: 'a:main', projectId: 'a', name: 'main', headId: 'v1', at: 3 });
    const events: unknown[] = [];
    persistRoom(doc, store, { emit: (e: unknown) => events.push(e) });
    expect(store.getVersion('a', 'v1')).toBeTruthy();
    expect(store.branches('a')[0].headId).toBe('v1');
    expect(store.getProject('a')?.value.name).toBe('old');
    persistRoom(doc, store, { emit: (e: unknown) => events.push(e), song: true });
    expect(store.getProject('a')?.value.name).toBe('In the room');
    expect(events).toHaveLength(1);
  });
});

describe('the API', () => {
  let srv: http.Server;
  let base: string;
  let store: FsStore;
  let pairing: Pairing;
  let api: ReturnType<typeof createStoreApi>;
  const start = async (opts: { storeToken?: string } = {}) => {
    store = new FsStore({ dir, quota: 1e7 });
    pairing = new Pairing({ code: '123456' });
    api = createStoreApi({ store, pairing, allowedOrigins: ['https://demo.example'], ...opts });
    const wss = new WebSocketServer({ noServer: true });
    srv = http.createServer(async (req, res) => {
      if (!(await api.handleHttp(req, res))) res.writeHead(404).end();
    });
    srv.on('upgrade', (req, socket, head) => {
      if (api.handles(new URL(req.url!, 'http://x').pathname)) api.upgrade(wss, req, socket, head);
      else socket.destroy();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}${PREFIX}`;
  };
  afterEach(() => new Promise((r) => srv.close(r)));

  it('runs a project through PUT, a 409 and GET', async () => {
    await start();
    const put = (body: unknown, etag?: string) => fetch(`${base}/projects/a`, { method: 'PUT', body: JSON.stringify(body), headers: etag ? { 'if-match': `"${etag}"` } : {} });
    const first = await put(song('a'));
    const etag = (await first.json()).etag;
    expect((await put(song('a', 'two'), etag)).status).toBe(200);
    const late = await put(song('a', 'late'), etag);
    expect(late.status).toBe(409);
    expect((await late.json()).etag).toBe(store.getProject('a').etag);
    const got = await fetch(`${base}/projects/a`);
    expect(got.headers.get('etag')).toBe(`"${store.getProject('a').etag}"`);
    expect((await got.json()).name).toBe('two');
    expect((await (await fetch(`${base}/projects`)).json())[0].id).toBe('a');
    expect((await fetch(`${base}/projects/a`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${base}/projects/a`)).status).toBe(404);
  });
  it('stores binary samples and answers HEAD', async () => {
    await start();
    const url = `${base}/samples/smp_1`;
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(404);
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect((await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-type': 'audio/wav', 'x-sample-name': encodeURIComponent('Più forte.wav') } })).status).toBe(201);
    const r = await fetch(url);
    expect(r.headers.get('content-type')).toBe('audio/wav');
    expect(decodeURIComponent(r.headers.get('x-sample-name')!)).toBe('Più forte.wav');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...bytes]);
  });
  it('answers 507 when a sample does not fit', async () => {
    await start();
    expect((await fetch(`${base}/samples/smp_big`, { method: 'PUT', body: new Uint8Array(2e7) })).status).toBe(507);
  });
  it('version bytes survive the JSON API', async () => {
    await start();
    const snapshot = Buffer.from(gzipSync('{"a":1}')).toString('base64');
    const v = { id: 'v1', projectId: 'a', parentIds: [], branch: 'main', label: '', createdAt: 1, author: 'user', snapshot };
    expect((await fetch(`${base}/projects/a/versions/v1`, { method: 'PUT', body: JSON.stringify(v) })).status).toBe(200);
    expect((await (await fetch(`${base}/projects/a/versions`)).json()).map((x: { id: string }) => x.id)).toEqual(['v1']);
    expect((await (await fetch(`${base}/projects/a/versions/v1`)).json()).snapshot).toBe(snapshot);
  });
  it('takes a proposal from a fork, numbers it, and it survives a restart', async () => {
    await start();
    await fetch(`${base}/projects/a`, { method: 'PUT', body: JSON.stringify(song('a')) });
    const snapshot = Buffer.from(gzipSync('{}')).toString('base64');
    const body = (id: string) => JSON.stringify({ proposal: { id, title: 'Bass', status: 'open' }, version: { id, parentIds: [], label: 'x', createdAt: 1, author: 'user', snapshot } });
    const one = await (await fetch(`${base}/projects/a/proposals`, { method: 'POST', body: body('v1') })).json();
    const two = await (await fetch(`${base}/projects/a/proposals`, { method: 'POST', body: body('v2') })).json();
    expect([one.number, two.number]).toEqual([1, 2]);
    await new Promise((r) => srv.close(r));
    await start();
    expect((await (await fetch(`${base}/projects/a/proposals`)).json()).map((p: { number: number }) => p.number)).toEqual([1, 2]);
    expect(store.branches('a').map((b: { name: string }) => b.name)).toEqual(['pr/1', 'pr/2']);
  });
  it('serves a cassette to anyone, and takes it down', async () => {
    await start();
    const root = base.replace('/api/store/v1', '');
    expect((await fetch(`${base}/cassettes/tape1/1/index.html`, { method: 'PUT', body: '<!doctype html>' })).status).toBe(200);
    expect((await fetch(`${base}/cassettes/tape1/1/b/x.bin`, { method: 'PUT', body: 'noise' })).status).toBe(200);
    const page = await fetch(`${root}/c/tape1/1/`);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await (await fetch(`${root}/c/tape1/1/b/x.bin`)).text()).toBe('noise');
    expect((await fetch(`${root}/c/tape1/1/../../tokens.json`)).status).toBe(404);
    expect((await fetch(`${root}/c/tape1/1/secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/cassettes/tape1/../evil/x`, { method: 'PUT', body: 'x' })).status).toBeGreaterThanOrEqual(400);
    await fetch(`${base}/cassettes/tape1`, { method: 'DELETE' });
    expect((await fetch(`${root}/c/tape1/1/`)).status).toBe(404);
  });
  it('the inbox takes only sealed packets for a known cassette, and says nothing to the rest', async () => {
    await start();
    const inbox = `${base.replace('/api/store/v1', '')}/api/cassette/v1/inbox`;
    const packet = JSON.stringify({ format: 'openband-reply-box/1', body: 'x' });
    await fetch(`${base}/cassettes/tape1/1/c.bin`, { method: 'PUT', body: 'x' });
    expect((await fetch(`${inbox}?s=nope`, { method: 'POST', body: packet })).status).toBe(404);
    expect((await fetch(`${inbox}?s=tape1`, { method: 'POST', body: 'hello' })).status).toBe(404);
    expect((await fetch(`${inbox}?s=tape1`, { method: 'POST', body: packet })).status).toBe(202);
    const [id] = await (await fetch(`${base}/cassettes/inbox`)).json();
    expect(await (await fetch(`${base}/cassettes/packet/${id}`)).json()).toMatchObject({ body: 'x' });
    await fetch(`${base}/inbox-done/${id}`, { method: 'POST' });
    expect(await (await fetch(`${base}/cassettes/inbox`)).json()).toEqual([]);
  });
  it('slows down whoever floods the inbox', () => {
    let t = 0;
    const r = new RateLimit({ max: 2, windowMs: 100, now: () => t });
    expect([r.take('a'), r.take('a'), r.take('a'), r.take('b')]).toEqual([true, true, false, true]);
    t = 200;
    expect(r.take('a')).toBe(true);
  });
  it('tells listeners what changed, on a socket that needs no token here', async () => {
    await start();
    const ws = new WebSocket(`${base.replace('http', 'ws')}/events`);
    await new Promise((r) => ws.once('open', r));
    const event = new Promise<string>((r) => ws.once('message', (m) => r(String(m))));
    await fetch(`${base}/projects/a`, { method: 'PUT', body: JSON.stringify(song('a')), headers: { 'x-openband-client': 'laptop' } });
    expect(JSON.parse(await event)).toMatchObject({ kind: 'project_changed', id: 'a', by: 'laptop' });
    ws.close();
  });
  it('a pair of bad ids in the URL is a 400, and nothing escapes the folder', async () => {
    await start();
    expect((await fetch(`${base}/projects/..%2F..%2Fetc`)).status).toBe(400);
    expect((await fetch(`${base}/samples/..%2Fx`, { method: 'PUT', body: 'x' })).status).toBe(400);
  });
  it('a page from elsewhere is refused; an allowed one must pair, and the token survives a restart', async () => {
    await start();
    expect((await fetch(`${base}/projects`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const origin = { origin: 'https://demo.example' };
    const denied = await fetch(`${base}/projects`, { headers: origin });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('access-control-allow-origin')).toBe('https://demo.example');
    expect((await fetch(`${base}/pair`, { method: 'POST', headers: origin, body: JSON.stringify({ code: '000000' }) })).status).toBe(403);
    const { token } = await (await fetch(`${base}/pair`, { method: 'POST', headers: origin, body: JSON.stringify({ code: '123-456' }) })).json();
    const auth = { ...origin, authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/projects`, { headers: auth })).status).toBe(200);
    expect(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')).not.toContain(token);
    await new Promise((r) => srv.close(r));
    await start();
    expect((await fetch(`${base}/projects`, { headers: auth })).status).toBe(200);
  });
  it('a forwarded request is never "this computer", even from 127.0.0.1', async () => {
    await start();
    expect((await fetch(`${base}/projects`, { headers: { 'x-forwarded-for': '8.8.8.8' } })).status).toBe(403);
    expect((await fetch(`${base}/projects`, { headers: { 'cf-connecting-ip': '8.8.8.8' } })).status).toBe(403);
  });
  it('from outside the LAN the instance token comes on top of pairing', async () => {
    await start({ storeToken: 'long-secret' });
    const headers = { 'x-forwarded-for': '8.8.8.8' };
    expect((await fetch(`${base}/projects`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/pair`, { method: 'POST', headers, body: JSON.stringify({ code: '123456' }) })).status).toBe(403);
    const pair = await fetch(`${base}/pair`, { method: 'POST', headers: { ...headers, 'x-store-token': 'long-secret' }, body: JSON.stringify({ code: '123456' }) });
    const { token } = await pair.json();
    expect((await fetch(`${base}/projects`, { headers: { ...headers, 'x-store-token': 'long-secret', authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${base}/projects`, { headers: { ...headers, authorization: `Bearer ${token}` } })).status).toBe(403);
  });
  it('recognises what is local', () => {
    const req = (h: Record<string, string>, addr = '127.0.0.1') => ({ headers: { host: 'localhost:7777', ...h }, socket: { remoteAddress: addr } }) as never;
    expect(isLocalRequest(req({}))).toBe(true);
    expect(isLocalRequest(req({ origin: 'http://localhost:7777' }))).toBe(true);
    expect(isLocalRequest(req({}, '192.168.1.5'))).toBe(false);
    expect(isLocalRequest(req({ host: 'evil.example' }))).toBe(false);
    expect(isLocalRequest(req({ origin: 'https://evil.example' }))).toBe(false);
  });
});
