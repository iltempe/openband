import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlugHostSession, scanBundle, scanPlugins } from './plughost.mjs';
import { hostArch, machoArchs, vendorOf } from './plugdiag.mjs';

// A stand-in for openband-plughost: `scan <bundle>` and `host` (the framed protocol), behaving like the
// bundle's name says — "sleepy" waits doing nothing (an activation window), "busy" burns CPU, "slowish"
// answers after 2 s. Real plugins can't be made to hang on purpose; the timing and the diagnosis are ours.
const FAKE = `
const [mode, bundle] = process.argv.slice(2);
const forever = () => setInterval(() => {}, 1 << 30);
const burn = () => { for (;;) Math.sqrt(Math.random()); };
if (mode === 'scan') {
  const answer = () => process.stdout.write(JSON.stringify({ plugins: [{ id: 'x', name: require('path').basename(bundle), vendor: 'Test', version: '1', features: ['instrument'] }] }));
  if (/sleepy/i.test(bundle)) forever();
  else if (/busy/i.test(bundle)) burn();
  else if (/slowish/i.test(bundle)) setTimeout(answer, 2000);
  else answer();
} else {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0), type = buf[4], payload = buf.subarray(5, 4 + len).toString();
      buf = buf.subarray(4 + len);
      if (type === 1 && !/sleepy/i.test(payload)) {
        const body = Buffer.from(JSON.stringify({ ok: true, name: 'Fake', latency: 0, inputs: 0, outputs: 2, params: [] }));
        const head = Buffer.alloc(5); head.writeUInt32LE(body.length + 1, 0); head[4] = 1;
        process.stdout.write(Buffer.concat([head, body]));
      }
    }
  });
}
`;

let dir = '';
let host = '';
const bundle = (name: string, plist?: string, binary?: Buffer) => {
  const b = path.join(dir, 'plugins', name);
  fs.mkdirSync(path.join(b, 'Contents', 'MacOS'), { recursive: true });
  if (plist) fs.writeFileSync(path.join(b, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${plist}</string><key>CFBundleExecutable</key><string>bin</string></dict></plist>`);
  fs.writeFileSync(path.join(b, 'Contents', 'MacOS', 'bin'), binary ?? Buffer.from('not a binary'));
  return b;
};
/** A thin 64-bit Mach-O header for one CPU. */
const macho = (arch: 'arm64' | 'x86_64') => {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(0xfeedfacf, 0);
  h.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  return h;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-plugdiag-'));
  host = path.join(dir, 'fake-plughost');
  fs.writeFileSync(host, `#!${process.execPath}\n${FAKE}`);
  fs.chmodSync(host, 0o755);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('when a native plugin takes too long', () => {
  it('waiting doing nothing (an activation window): says so, and what to open for that vendor', async () => {
    const b = bundle('Sleepy Analog Lab V.vst3', 'com.arturia.AnalogLabV');
    const e = await scanBundle(host, b, 1200).then(() => null, (x) => x);
    expect(e.diagnosis.state).toBe('idle');
    expect(e.message).toMatch(/waited for 1 s doing nothing.*activation or licence window \(Arturia Software Center\)/);
    expect(e.diagnosis.hints.join(' ')).toMatch(/Arturia Software Center.*activated/);
    expect(e.diagnosis.vendor).toBe('Arturia');
  }, 20000);

  it('still working when the limit ran out: says it was busy and that a retry gets more time', async () => {
    const e = await scanBundle(host, bundle('Busy Library.clap'), 1200).then(() => null, (x) => x);
    expect(e.diagnosis.state).toBe('busy');
    expect(e.message).toMatch(/still working \(CPU \d+%/);
    expect(e.diagnosis.hints[0]).toMatch(/three times as long/);
  }, 20000);

  it('a retry really gets three times as long: a plugin that needs 2 s fails at 1 s, passes when retried', async () => {
    const b = bundle('Slowish Piano.vst3');
    const dirs = [path.join(dir, 'plugins')];
    const cacheFile = path.join(dir, 'cache.json');
    for (const n of fs.readdirSync(dirs[0])) if (!/slowish/i.test(n)) fs.rmSync(path.join(dirs[0], n), { recursive: true });
    const first = await scanPlugins({ host, dirs, cacheFile, timeoutMs: 1000, audioUnits: false });
    expect(first.plugins).toEqual([]);
    expect(first.failed[0]).toMatchObject({ path: b, state: 'idle' });
    expect(first.failed[0].hints.length).toBeGreaterThan(0);
    // Ignored until asked: the cache keeps the reason.
    expect((await scanPlugins({ host, dirs, cacheFile, timeoutMs: 1000, audioUnits: false })).failed[0].reason).toBe(first.failed[0].reason);
    const again = await scanPlugins({ host, dirs, cacheFile, timeoutMs: 1000, retry: [b], audioUnits: false });
    expect(again.failed).toEqual([]);
    expect(again.plugins[0].name).toBe('Slowish Piano.vst3');
  }, 30000);

  it('built for the other CPU: refused at once, with why (no waiting)', async () => {
    process.env.OPENBAND_DIAG_FORCE_MACHO = '1';
    try {
      const other = hostArch() === 'arm64' ? 'x86_64' : 'arm64';
      const b = bundle('Old Synth.vst3', 'com.example.oldsynth', macho(other));
      expect(machoArchs(path.join(b, 'Contents', 'MacOS', 'bin'))).toEqual([other]);
      const t0 = Date.now();
      const e = await scanBundle(host, b, 5000).then(() => null, (x) => x);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(e.diagnosis.state).toBe('arch');
      expect(e.message).toMatch(/built for .* only/);
      const s = new PlugHostSession(host);
      await expect(s.load({ path: b, id: 'x' })).rejects.toThrow(/can't load on this computer.*Universal/);
      s.close?.();
      // The right CPU loads.
      const ok = bundle('New Synth.vst3', 'com.example.newsynth', macho(hostArch() as 'arm64' | 'x86_64'));
      const s2 = new PlugHostSession(host);
      await expect(s2.load({ path: ok, id: 'x' })).resolves.toMatchObject({ ok: true, name: 'Fake' });
      s2.close?.();
    } finally {
      delete process.env.OPENBAND_DIAG_FORCE_MACHO;
    }
  }, 20000);

  it('a load that never answers: the error names the plugin phase and the diagnosis, not "did not answer"', async () => {
    const b = bundle('Sleepy Keys.vst3', 'com.native-instruments.Kontakt');
    const s = new PlugHostSession(host);
    const e = await s.load({ path: b, id: 'x', timeoutMs: 1200 }).then(() => null, (x) => x);
    expect(e.diagnosis.state).toBe('idle');
    expect(e.message).toMatch(/stopped loading .*Native Access/);
    s.close?.();
  }, 20000);

  it('knows the vendors that need their own app to activate', () => {
    expect(vendorOf(bundle('Pigments.vst3', 'com.arturia.Pigments')).manager).toBe('Arturia Software Center');
    expect(vendorOf(bundle('Plain.clap', 'org.example.plain')).manager).toBeUndefined();
  });
});
