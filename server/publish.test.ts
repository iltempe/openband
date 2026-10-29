// Publishing adapters against a mock of each platform (SPEC v0.6 G6): keys and OAuth with PKCE, files in
// from the studio, the Internet Archive's S3 PUTs and retry, the Commons chunked upload with a failed chunk
// resumed and an expired token renewed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain ESM modules
import { PublishHost } from './publish/index.mjs';
// @ts-expect-error
import { PublishStore } from './publish/store.mjs';
// @ts-expect-error
import { createFakePlatforms } from './fixtures/fake-platforms.mjs';

let fake: ReturnType<typeof createFakePlatforms>;
let mock: string;
let host: InstanceType<typeof PublishHost>;
let studio: http.Server;
let base: string;
const notes: unknown[] = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-publish-'));

beforeAll(async () => {
  fake = createFakePlatforms();
  mock = `http://127.0.0.1:${await fake.listen()}`;
  studio = http.createServer(async (req, res) => {
    if (!(await host.handleHttp(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => studio.listen(0, '127.0.0.1', () => ok()));
  const port = (studio.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  host = new PublishHost({ store: new PublishStore(path.join(dir, 'publish.json')), port, mock, retryDelay: 1, notify: (m: unknown) => notes.push(m) });
});
afterAll(async () => {
  await fake.close();
  studio.close();
  host.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const asset = async (data: Uint8Array, name: string, type = 'application/octet-stream', headers: Record<string, string> = {}) =>
  fetch(`${base}/publish/asset`, { method: 'POST', body: data as BodyInit, headers: { 'content-type': type, 'x-openband-token': host.token, 'x-openband-name': encodeURIComponent(name), origin: 'openband://app', ...headers } });

describe('files from the studio', () => {
  it('need the bridge token and a local origin', async () => {
    expect((await asset(new Uint8Array(4), 'a', undefined, { 'x-openband-token': 'nope' })).status).toBe(403);
    expect((await asset(new Uint8Array(4), 'a', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    const ok = await asset(new Uint8Array(4), 'a');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('openband://app');
  });
  it('the page learns what is set up, never a secret', async () => {
    await host.handle({ op: 'credentials', platform: 'archive', values: { access: 'ACCESS', secret: 'SECRET', other: 'x' } });
    const t = (await host.handle({ op: 'targets' })).targets;
    expect(JSON.stringify(t)).not.toContain('SECRET');
    expect(t.find((x: { id: string }) => x.id === 'archive')).toMatchObject({ configured: true, authorized: true });
    expect(fs.statSync(path.join(dir, 'publish.json')).mode & 0o777).toBe(0o600);
  });
});

describe('Internet Archive', () => {
  it('creates the item with its metadata, then adds the files; retries a 503', async () => {
    const flac = await (await asset(new Uint8Array(5000).fill(7), 'song.flac', 'audio/flac')).json();
    const png = await (await asset(new Uint8Array(300).fill(1), 'cover.png', 'image/png')).json();
    await fetch(`${mock}/__mock/config`, { method: 'POST', body: JSON.stringify({ archive503: 1 }) });
    const progress: number[] = [];
    const r = await host.handle(
      { op: 'upload', platform: 'archive', files: [{ asset: flac.asset, name: 'Notte - iltempe.flac' }, { asset: png.asset }], package: { identifier: 'openband-iltempe-notte-20261025-ab12', meta: { mediatype: 'audio', collection: 'opensource_audio', title: 'Notte à Trastevere', creator: 'iltempe', licenseurl: 'https://creativecommons.org/licenses/by/4.0/', subject: ['lo-fi', 'notte'] } } },
      (f: number) => progress.push(f),
    );
    expect(r).toEqual({ id: 'openband-iltempe-notte-20261025-ab12', url: `${mock}/archive/details/openband-iltempe-notte-20261025-ab12` });
    const item = fake.state.archive['openband-iltempe-notte-20261025-ab12'];
    expect(item.meta).toMatchObject({ title: 'Notte à Trastevere', creator: 'iltempe', licenseurl: 'https://creativecommons.org/licenses/by/4.0/', subject: ['lo-fi', 'notte'], collection: 'opensource_audio' });
    expect(Object.keys(item.files)).toEqual(['Notte - iltempe.flac', 'cover.png']);
    expect(item.files['Notte - iltempe.flac'].size).toBe(5000);
    expect(progress.at(-1)).toBe(1);
    expect(fake.state.log.filter((l: string) => l.startsWith('PUT')).length).toBe(3); // one 503, then two files
    expect((await host.handle({ op: 'status', platform: 'archive', id: r.id })).state).toBe('live');
  });
  it('wrong keys: a clear error', async () => {
    await host.handle({ op: 'credentials', platform: 'archive', values: { secret: 'WRONG' } });
    const a = await (await asset(new Uint8Array(10), 'x.flac')).json();
    await expect(host.handle({ op: 'upload', platform: 'archive', files: [{ asset: a.asset }], package: { identifier: 'openband-x-20261025-0000', meta: { title: 'x' } } })).rejects.toThrow(/refused the keys/);
    await host.handle({ op: 'credentials', platform: 'archive', values: { secret: 'SECRET' } });
  });
});

describe('Wikimedia Commons', () => {
  it('signs in with OAuth 2.0 + PKCE through the local server', async () => {
    await host.handle({ op: 'credentials', platform: 'wikimedia', values: { client_id: 'commons-client' } });
    const { url } = await host.handle({ op: 'authorize', platform: 'wikimedia' });
    expect(url).toContain('code_challenge_method=S256');
    const consent = await fetch(url, { redirect: 'manual' });
    const back = consent.headers.get('location')!;
    expect(back.startsWith(`${base}/publish/oauth/callback`)).toBe(true);
    const done = await fetch(back);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Signed in to Wikimedia Commons');
    expect(notes.at(-1)).toEqual({ type: 'publish_authorized', platform: 'wikimedia', ok: true });
    expect((await host.handle({ op: 'targets' })).targets.find((x: { id: string }) => x.id === 'wikimedia').authorized).toBe(true);
  });
  it('a callback with a forged verifier fails PKCE', async () => {
    const { url } = await host.handle({ op: 'authorize', platform: 'wikimedia' });
    const state = new URL(url).searchParams.get('state')!;
    host.pendingAuth.get(state).verifier = 'not-the-verifier';
    const back = (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
    const res = await fetch(back);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('PKCE verification failed');
  });
  it('uploads in chunks: a failed chunk is resumed, an expired token renewed (single-use refresh)', async () => {
    const size = 9 * 1024 * 1024 + 123;
    const data = new Uint8Array(size).map((_, i) => i % 251);
    const a = await (await asset(data, 'song.flac', 'audio/flac')).json();
    await fetch(`${mock}/__mock/config`, { method: 'POST', body: JSON.stringify({ failChunk: 4 * 1024 * 1024, expireNext: true }) });
    const text = '=={{int:filedesc}}==\n{{Information\n|description={{en|1=Notte}}\n}}\n=={{int:license-header}}==\n{{cc-by-4.0}}\n';
    const r = await host.handle({ op: 'upload', platform: 'wikimedia', files: [{ asset: a.asset }], package: { filename: 'Notte - iltempe.flac', text, comment: 'Uploaded with OpenBand' } });
    const f = fake.state.commons.files['Notte_-_iltempe.flac'];
    expect(f.size).toBe(size);
    expect(f.chunks).toBe(3);
    expect(f.text).toBe(text);
    expect(fake.state.oauth.refreshed).toBe(1);
    expect(r.id).toBe('File:Notte_-_iltempe.flac');
    expect((await host.handle({ op: 'status', platform: 'wikimedia', id: r.id })).state).toBe('live');
  });
  it('the same file name twice: told to change the title', async () => {
    const a = await (await asset(new Uint8Array(100), 'song.flac')).json();
    await expect(host.handle({ op: 'upload', platform: 'wikimedia', files: [{ asset: a.asset }], package: { filename: 'Notte - iltempe.flac', text: 'x', comment: 'x' } })).rejects.toThrow(/exists already/);
  });
  it('or with an owner-only consumer\'s token, pasted', async () => {
    await host.handle({ op: 'credentials', platform: 'wikimedia', values: { access_token: 'owner-only-token' } });
    expect(host.store.get('wikimedia')).toMatchObject({ access: 'owner-only-token' });
    expect(host.store.get('wikimedia').access_token).toBeUndefined();
    const t = (await host.handle({ op: 'targets' })).targets.find((x: { id: string }) => x.id === 'wikimedia');
    expect(t.authorized).toBe(true);
    expect(JSON.stringify(t)).not.toContain('owner-only-token');
  });
  it('signed out: asked to sign in', async () => {
    await host.handle({ op: 'forget', platform: 'wikimedia' });
    const a = await (await asset(new Uint8Array(10), 'x.flac')).json();
    await expect(host.handle({ op: 'upload', platform: 'wikimedia', files: [{ asset: a.asset }], package: { filename: 'y.flac', text: 'x' } })).rejects.toThrow(/Not signed in/);
  });
});

// G6c2: SoundCloud, YouTube, Mixcloud.
const signIn = async (platform: string) => {
  const { url } = await host.handle({ op: 'authorize', platform });
  const back = (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
  const done = await fetch(back);
  return { url, back, status: done.status, text: await done.text() };
};

describe('SoundCloud', () => {
  it('signs in (PKCE and the app secret) and uploads the master, artwork and metadata', async () => {
    await host.handle({ op: 'credentials', platform: 'soundcloud', values: { client_id: 'sc-client', client_secret: 'sc-secret' } });
    const s = await signIn('soundcloud');
    expect(s.status).toBe(200);
    expect(s.url).toContain('code_challenge_method=S256');
    const flac = await (await asset(new Uint8Array(4000).fill(3), 'Fuori.flac', 'audio/flac')).json();
    const art = await (await asset(new Uint8Array(500).fill(9), 'cover.png', 'image/png')).json();
    await fetch(`${mock}/__mock/config`, { method: 'POST', body: JSON.stringify({ scExpireNext: true }) });
    const before = fake.state.oauth.refreshed ?? 0;
    const r = await host.handle({ op: 'upload', platform: 'soundcloud', files: [{ asset: flac.asset, role: 'audio' }, { asset: art.asset, role: 'artwork' }], package: { track: { title: 'Fuori', description: 'x', genre: 'Lo-fi', tag_list: '"lo fi" notte', license: 'cc-by', sharing: 'private' } } });
    const t = fake.state.soundcloud.tracks.at(-1);
    expect(t.fields).toMatchObject({ 'track[title]': 'Fuori', 'track[license]': 'cc-by', 'track[sharing]': 'private', 'track[tag_list]': '"lo fi" notte' });
    expect(t.fields['track[asset_data]']).toMatchObject({ name: 'Fuori.flac', size: 4000 });
    expect(t.fields['track[artwork_data]']).toMatchObject({ name: 'cover.png', size: 500 });
    expect(fake.state.oauth.refreshed).toBe(before + 1); // the token expired on the way: renewed once
    expect(r.url).toMatch(/track-1000$/);
  });
});

describe('YouTube', () => {
  it('signs in for an offline token, then the resumable upload goes on after a dropped piece', async () => {
    await host.handle({ op: 'credentials', platform: 'youtube', values: { client_id: 'yt-client', client_secret: 'yt-secret' } });
    const s = await signIn('youtube');
    expect(s.status).toBe(200);
    expect(s.url).toContain('access_type=offline');
    const size = 20 * 1024 * 1024 + 77;
    const mp4 = await (await asset(new Uint8Array(size).map((_, i) => i % 199), 'Fuori.mp4', 'video/mp4')).json();
    await fetch(`${mock}/__mock/config`, { method: 'POST', body: JSON.stringify({ ytFailAt: 8 * 1024 * 1024, ytExpireNext: true }) });
    const progress: number[] = [];
    const meta = { snippet: { title: 'Fuori', description: 'x', tags: ['lo-fi'], categoryId: '10' }, status: { privacyStatus: 'unlisted', license: 'creativeCommon', selfDeclaredMadeForKids: false, containsSyntheticMedia: true } };
    const r = await host.handle({ op: 'upload', platform: 'youtube', files: [{ asset: mp4.asset, role: 'video' }], package: meta }, (f: number) => progress.push(f));
    const v = fake.state.youtube.videos.at(-1);
    expect(v.size).toBe(size);
    expect(v.snippet.title).toBe('Fuori');
    expect(v.status).toMatchObject({ privacyStatus: 'unlisted', license: 'creativeCommon', containsSyntheticMedia: true });
    // Three pieces of 8 MiB, one dropped half-way and sent again from where it stopped.
    expect(v.puts).toBeGreaterThanOrEqual(4);
    expect(r).toEqual({ id: v.id, url: `https://www.youtube.com/watch?v=${v.id}` });
    expect(progress.at(-1)).toBe(1);
  });
});

describe('Mixcloud', () => {
  it("signs in without a state (the callback is Mixcloud's own), uploads the MP3, waits when rate-limited", async () => {
    await host.handle({ op: 'credentials', platform: 'mixcloud', values: { client_id: 'mc-client', client_secret: 'mc-secret' } });
    const t = (await host.handle({ op: 'targets' })).targets.find((x: { id: string }) => x.id === 'mixcloud');
    expect(t.redirect_uri).toMatch(/\/publish\/oauth\/callback\/mixcloud$/);
    const s = await signIn('mixcloud');
    expect(s.back).not.toContain('state=');
    expect(s.status).toBe(200);
    const mp3 = await (await asset(Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3]), 'Fuori.mp3', 'audio/mpeg')).json();
    const pic = await (await asset(new Uint8Array(100), 'cover.png', 'image/png')).json();
    await fetch(`${mock}/__mock/config`, { method: 'POST', body: JSON.stringify({ mcRateLimit: 1 }) });
    const r = await host.handle({ op: 'upload', platform: 'mixcloud', files: [{ asset: mp3.asset, role: 'audio' }, { asset: pic.asset, role: 'artwork' }], package: { name: 'Fuori', description: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f'] } });
    const u = fake.state.mixcloud.uploads.at(-1);
    expect(u.fields.mp3).toMatchObject({ head: 'ID3' });
    expect(Object.keys(u.fields).filter((k) => /^tags-\d-tag$/.test(k))).toHaveLength(5);
    expect(r).toEqual({ id: '/openband-user/fuori/', url: `${mock}/mixcloud/site/openband-user/fuori/` });
  });
});
