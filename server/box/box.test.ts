import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_RATE as SR } from './capture.mjs';
import { applyFlags, BOX_DEFAULTS, parseArgs, toForget } from './config.mjs';
import { launchdPlist, systemdUnit } from './service.mjs';
import { tunnelCommand, tunnelUrl } from './tunnel.mjs';

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-boxcli-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('settings', () => {
  it('reads the command line', () => {
    const { sub, flags } = parseArgs(['install', '--pin', '42', '--names=Voce,Basso', '--channels', '1-8', '--threshold', '-40']);
    expect(sub).toBe('install');
    expect(applyFlags(BOX_DEFAULTS, flags)).toMatchObject({ pin: '000042', names: ['Voce', 'Basso'], channels: 8, threshold: -40 });
    expect(() => applyFlags(BOX_DEFAULTS, { channels: '99' })).toThrow('--channels');
  });
  it('forgets the oldest first, never a starred one', () => {
    const s = (id: string, at: number, starred = false) => ({ id, at, bytes: 1e9, starred });
    const all = [s('c', 3), s('a', 1, true), s('b', 2), s('d', 4)];
    expect(toForget(all, { sessions: 2 }).map((x) => x.id)).toEqual(['b', 'c']);
    expect(toForget(all, { gb: 3 }).map((x) => x.id)).toEqual(['b']);
    expect(toForget(all, { sessions: 9 })).toEqual([]);
  });
  it('writes a service that restarts itself and joins the audio group', () => {
    const u = systemdUnit({ node: '/usr/bin/node', bin: '/opt/b.mjs', data: '/var/lib/openband' });
    expect(u).toContain('ExecStart=/usr/bin/node /opt/b.mjs box');
    expect(u).toContain('Restart=always');
    expect(u).toContain('SupplementaryGroups=audio gpio');
    expect(launchdPlist({ node: 'n', bin: 'b', data: 'd', log: 'l' })).toContain('<key>KeepAlive</key>');
  });
});

describe('the tunnel', () => {
  it('finds the public address in what the tool prints', () => {
    expect(tunnelUrl('INF |  https://calm-river.trycloudflare.com  |')).toBe('https://calm-river.trycloudflare.com');
    expect(tunnelUrl('Available on the internet: https://box.tail1234.ts.net/')).toBe('https://box.tail1234.ts.net/');
    expect(tunnelUrl('starting')).toBeNull();
  });
  it('asks each tool in its own way', () => {
    expect(tunnelCommand('cloudflared', 7777).args).toContain('http://localhost:7777');
    expect(tunnelCommand('tailscale', 7777)).toEqual({ cmd: 'tailscale', args: ['funnel', '7777'] });
  });
});

describe('openband box, as a process', () => {
  it('records three songs from a source, makes a version, and serves it to the API', async () => {
    const CH = 2;
    const part = (s: number, amp: number) => {
      const b = Buffer.alloc(s * SR * CH * 3);
      for (let i = 0; i < b.length; i += 3) b.writeIntLE(Math.round(((i / 3) % 2 ? -1 : 1) * amp * 8e6), i, 3);
      return b;
    };
    const song = part(3, 0.2);
    const gap = part(10, 0);
    const pcm = path.join(dir, 'source.pcm');
    fs.writeFileSync(pcm, Buffer.concat([part(1, 0), song, gap, song, gap, song, part(13, 0)]));
    fs.writeFileSync(path.join(dir, 'box.json'), JSON.stringify({ endMs: 12000, channels: CH, names: ['Voce', 'Chitarra'], project: 'La band', pin: '123456', port: 7855 }));
    const child = spawn(process.execPath, ['bin/openband.mjs', 'box', '--data', dir, '--source', pcm], { env: { ...process.env, OPENBAND_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    const base = 'http://127.0.0.1:7855/api/store/v1';
    try {
      let sessions: { imported?: string; songs: number; projectId: string }[] = [];
      for (let i = 0; i < 100 && !sessions[0]?.imported; i++) {
        await new Promise((r) => setTimeout(r, 200));
        sessions = await fetch(`${base}/box/sessions`).then((r) => (r.ok ? r.json() : []), () => []);
      }
      expect(sessions[0]).toMatchObject({ songs: 3 });
      expect(sessions[0].imported).toBeTruthy();
      const id = sessions[0].projectId;
      const versions = await (await fetch(`${base}/projects/${id}/versions`)).json();
      expect(versions[0].branch).toBe('prove');
      expect(await (await fetch(`${base}/box/status`)).json()).toMatchObject({ state: 'armed', project: 'La band' });
      const wav = await fetch(`${base}/box/sessions/${(await (await fetch(`${base}/box/sessions`)).json())[0].id}/channels/1.wav`);
      expect(wav.headers.get('content-type')).toBe('audio/wav');
      expect((await wav.arrayBuffer()).byteLength).toBeGreaterThan(SR);
      expect((await (await fetch(`${base}/box/disarm`, { method: 'POST' })).json()).state).toBe('off');
    } finally {
      child.kill();
    }
  }, 40000);
});
