// Updating the desktop app from inside it (issue #4): which package, checked downloads, how it installs.
import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain ESM module
import { assetName, download, installPlan, latestRelease, macSwapScript } from './updater.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-upd-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const bytes = Buffer.from('OpenBand update '.repeat(1000));
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const fakeFetch = (body: Buffer) => async () => new Response(body, { headers: { 'content-length': String(body.length) } });

describe('the package for this computer', () => {
  it('per platform and architecture, with the stable release names', () => {
    expect(assetName({ platform: 'darwin', arch: 'arm64' })).toBe('OpenBand-mac-arm64.zip');
    expect(assetName({ platform: 'darwin', arch: 'x64' })).toBe('OpenBand-mac-x64.zip');
    expect(assetName({ platform: 'win32', arch: 'x64' })).toBe('OpenBand-win-x64.exe');
    expect(assetName({ platform: 'linux', arch: 'x64', appImage: true })).toBe('OpenBand-linux-x86_64.AppImage');
    expect(assetName({ platform: 'linux', arch: 'arm64' })).toBe('OpenBand-linux-arm64.deb');
    expect(assetName({ platform: 'linux', arch: 'x64' })).toBe('OpenBand-linux-amd64.deb');
  });
  it('reads the release with each asset\'s SHA-256', async () => {
    const r = await latestRelease({ fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v0.7.0', html_url: 'u', body: 'notes', assets: [{ name: 'a', browser_download_url: 'x', size: 3, digest: `sha256:${sha}` }, { name: 'b', browser_download_url: 'y', size: 3 }] })) });
    expect(r.version).toBe('0.7.0');
    expect(r.assets[0].sha256).toBe(sha);
    expect(r.assets[1].sha256).toBeNull();
  });
});

describe('the download', () => {
  it('is checked against its SHA-256', async () => {
    const progress: number[] = [];
    const file = await download({ name: 'OpenBand-mac-arm64.zip', url: 'x', size: bytes.length, sha256: sha }, dir, { fetchImpl: fakeFetch(bytes), onProgress: (f: number) => progress.push(f) });
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(progress.at(-1)).toBe(1);
  });
  it('a damaged one is refused and removed', async () => {
    await expect(download({ name: 'bad.zip', url: 'x', size: bytes.length, sha256: sha }, dir, { fetchImpl: fakeFetch(Buffer.from('tampered')) })).rejects.toThrow(/damaged/);
    expect(fs.existsSync(path.join(dir, 'bad.zip'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'bad.zip.part'))).toBe(false);
  });
  it('one without a checksum is not installed', async () => {
    await expect(download({ name: 'x.zip', url: 'x', size: 1, sha256: null }, dir, { fetchImpl: fakeFetch(bytes) })).rejects.toThrow(/no checksum/);
  });
});

describe('how it installs', () => {
  it('macOS: replaces the app bundle, unless it runs from its disk image', () => {
    expect(installPlan({ platform: 'darwin', file: '/t/u.zip', exe: '/Applications/OpenBand.app/Contents/MacOS/OpenBand' })).toEqual({ kind: 'replace-app', zip: '/t/u.zip', bundle: '/Applications/OpenBand.app' });
    expect(installPlan({ platform: 'darwin', file: '/t/u.zip', exe: '/Volumes/OpenBand 0.6.34/OpenBand.app/Contents/MacOS/OpenBand' }).kind).toBe('open');
  });
  it('Windows: the installer, silent, starting the app after; AppImage replaced; .deb opened', () => {
    expect(installPlan({ platform: 'win32', file: 'C:\\t\\u.exe', exe: 'C:\\x\\OpenBand.exe' })).toEqual({ kind: 'run-installer', file: 'C:\\t\\u.exe', args: ['/S', '--force-run'] });
    expect(installPlan({ platform: 'linux', file: '/t/n.AppImage', exe: '/tmp/.mount/openband', appImage: '/home/u/OpenBand.AppImage' })).toEqual({ kind: 'replace-appimage', file: '/t/n.AppImage', target: '/home/u/OpenBand.AppImage' });
    expect(installPlan({ platform: 'linux', file: '/t/n.deb', exe: '/opt/OpenBand/openband' }).kind).toBe('open');
  });
  it('the macOS swap script: waits for the app to quit, swaps, restores on failure, opens; quoted', () => {
    const s = macSwapScript({ pid: 4242, newApp: "/tmp/o'b/OpenBand.app", bundle: '/Applications/OpenBand.app' });
    expect(s).toContain('while kill -0 4242');
    expect(s).toContain("'/tmp/o'\\''b/OpenBand.app'");
    expect(s).toContain("|| mv '/Applications/OpenBand.app.old' '/Applications/OpenBand.app'");
    expect(s).toContain("open '/Applications/OpenBand.app'");
    execFileSync('/bin/sh', ['-n', '-c', s]); // valid shell
  });
  it('the swap really happens once the app has quit, and the new app is opened', async () => {
    const root = fs.mkdtempSync(path.join(dir, 'swap-'));
    const bundle = path.join(root, 'Applications', 'OpenBand.app');
    const newApp = path.join(root, 'update', 'OpenBand.app');
    fs.mkdirSync(bundle, { recursive: true });
    fs.mkdirSync(newApp, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'version'), 'old');
    fs.writeFileSync(path.join(newApp, 'version'), 'new');
    // The app: a process that quits in a moment. `open` is a stub that records what it opened.
    // Started through a shell that exits at once, so it is not this test's child (a child would linger as
    // a zombie while execFileSync blocks, and look alive to kill -0).
    const pid = Number(execFileSync('/bin/sh', ['-c', 'sleep 0.6 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$1" > "${path.join(root, 'opened')}"\n`, { mode: 0o755 });
    const script = macSwapScript({ pid, newApp, bundle });
    execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(fs.readFileSync(path.join(bundle, 'version'), 'utf8')).toBe('new');
    expect(fs.existsSync(`${bundle}.old`)).toBe(false);
    expect(fs.readFileSync(path.join(root, 'opened'), 'utf8').trim()).toBe(bundle);
  });
});
