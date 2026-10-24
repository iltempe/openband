// openband-plughost against its test fixtures (G8.2). Needs the host built:
//   cmake -S native/plughost -B build/plughost && cmake --build build/plughost
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT, PlugHostSession, clapDirs, findBundles, hostBinary, scanBundle, scanPlugins } from './plughost.mjs';

const build = path.resolve(__dirname, '..', 'build', 'plughost');
const host = hostBinary();
const fixtures = path.join(build, 'ob-fixtures.clap');
const hang = path.join(build, 'ob-hang.clap');
const ready = !!host && fs.existsSync(fixtures);

const blockOf = (n: number, f: (i: number) => number) => {
  const a = Float32Array.from({ length: n }, (_, i) => f(i));
  return [a, a.slice()];
};
const next = (s: PlugHostSession) => new Promise<{ seq: number; channels: Float32Array[] }>((r) => s.once('block', r));

describe('plugin folders', () => {
  it('knows the standard CLAP folders of each platform', () => {
    expect(clapDirs('darwin', {}, '/Users/x')).toEqual(['/Users/x/Library/Audio/Plug-Ins/CLAP', '/Library/Audio/Plug-Ins/CLAP']);
    expect(clapDirs('linux', {}, '/home/x')).toContain('/usr/lib/clap');
    expect(clapDirs('win32', { COMMONPROGRAMFILES: 'C:\\CPF' }, 'C:\\Users\\x')[0]).toMatch(/CPF.CLAP$/);
  });

  it('finds bundles two levels deep', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clapdirs-'));
    fs.mkdirSync(path.join(d, 'Vendor', 'Synth.clap', 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(d, 'fx.clap'), '');
    fs.writeFileSync(path.join(d, 'readme.txt'), '');
    expect(findBundles([d]).map((p) => path.relative(d, p))).toEqual(['Vendor/Synth.clap', 'fx.clap'].map((x) => x.split('/').join(path.sep)));
    fs.rmSync(d, { recursive: true });
  });
});

describe.skipIf(!ready)('openband-plughost with the fixtures', () => {
  it('scans a bundle: ids, names, kinds', async () => {
    const list = await scanBundle(host!, fixtures);
    expect(list.map((p) => p.id)).toEqual(['org.openband.fixture.gain', 'org.openband.fixture.delay', 'org.openband.fixture.crash', 'org.openband.fixture.synth']);
    expect(list[3].kind).toBe('instrument');
    expect(list[0]).toMatchObject({ format: 'clap', name: 'OB Fixture Gain', vendor: 'OpenBand', kind: 'effect', path: fixtures });
  });

  it('a bundle that hangs times out and lands on the ignore list, the others are still found', async () => {
    const t0 = Date.now();
    const r = await scanPlugins({ host: host!, dirs: [build], timeoutMs: 1500 });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.plugins.map((p) => p.id)).toContain('org.openband.fixture.gain');
    expect(r.failed).toEqual([{ path: hang, reason: 'did not answer in 2 s' }]);
  }, 20000);

  it('caches by modification time and retries the ignored bundle on request', async () => {
    const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clapcache-')), 'plugins.json');
    await scanPlugins({ host: host!, dirs: [build], timeoutMs: 1000, cacheFile });
    const t0 = Date.now();
    const again = await scanPlugins({ host: host!, dirs: [build], timeoutMs: 1000, cacheFile });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(again.failed.length).toBe(1);
    const retried = await scanPlugins({ host: host!, dirs: [build], timeoutMs: 1000, cacheFile, retry: [hang] });
    expect(retried.failed[0].reason).toMatch(/did not answer/);
  }, 20000);

  it('runs an effect block by block: gain, parameters, state', async () => {
    const s = new PlugHostSession(host!);
    const info = await s.load({ path: fixtures, id: 'org.openband.fixture.gain', sampleRate: 48000, maxBlock: 128 });
    expect(info).toMatchObject({ name: 'OB Fixture Gain', latency: 0, inputs: 2, outputs: 2 });
    expect(info.params[0]).toMatchObject({ id: 0, name: 'Gain', min: -24, max: 24, default: -6 });
    let p = next(s);
    s.process(7, blockOf(128, () => 0.5));
    let b = await p;
    expect(b.seq).toBe(7);
    expect(b.channels[0][10]).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 5);
    s.setParam(0, 6);
    p = next(s);
    s.process(8, blockOf(128, () => 0.5));
    b = await p;
    expect(b.channels[1][0]).toBeCloseTo(0.5 * Math.pow(10, 6 / 20), 5);
    const state = await s.getState();
    expect(state.toString()).toMatch(/^gain=6\./);
    expect(await s.setState(Buffer.from('gain=-12'))).toBe(true);
    p = next(s);
    s.process(9, blockOf(128, () => 1));
    b = await p;
    expect(b.channels[0][0]).toBeCloseTo(Math.pow(10, -12 / 20), 5);
    s.close();
  });

  it('reports a plugin latency', async () => {
    const s = new PlugHostSession(host!);
    const info = await s.load({ path: fixtures, id: 'org.openband.fixture.delay' });
    expect(info.latency).toBe(256);
    const x = blockOf(128, (i) => (i === 5 ? 1 : 0));
    const outs: number[] = [];
    for (let k = 0; k < 4; k++) {
      const p = next(s);
      s.process(k, k === 0 ? x : blockOf(128, () => 0));
      outs.push(...(await p).channels[0]);
    }
    expect(outs.indexOf(1)).toBe(256 + 5);
    s.close();
  });

  it('a crashing plugin takes down only its host process, which says so', async () => {
    const s = new PlugHostSession(host!);
    await s.load({ path: fixtures, id: 'org.openband.fixture.crash' });
    const p = next(s);
    s.process(0, blockOf(128, () => 0.1));
    expect((await p).channels[0][0]).toBeCloseTo(0.1, 6);
    const exited = new Promise<{ crashed: boolean; signal: string | null }>((r) => s.once('exit', r));
    s.setParam(1, 1);
    s.process(1, blockOf(128, () => 0.1));
    const e = await exited;
    expect(e.crashed).toBe(true);
    expect(e.signal ?? '').toMatch(/SIGABRT|SIGTRAP|SIGKILL|^$/);
  });

  it('says what went wrong when a plugin is missing', async () => {
    const s = new PlugHostSession(host!);
    await expect(s.load({ path: fixtures, id: 'org.openband.nope' })).rejects.toThrow(/cannot create org.openband.nope/);
  });

  it('plays notes on the exact sample of their event, and parameters too (sample-accurate)', async () => {
    const s = new PlugHostSession(host!);
    const info = await s.load({ path: fixtures, id: 'org.openband.fixture.synth' });
    expect(info).toMatchObject({ inputs: 0, outputs: 2, gui: false });
    expect(info.params).toEqual([expect.objectContaining({ id: 2, name: 'Level', value: 0.5 })]);
    const silence = () => [new Float32Array(128), new Float32Array(128)];
    let p = next(s);
    s.process(0, silence(), [{ offset: 37, kind: EVENT.NOTE_ON, key: 69, value: 1 }]);
    let out = (await p).channels[0];
    expect(out.findIndex((v) => v !== 0)).toBe(38); // sin(0) = 0 on the note's first sample
    expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(0.3);
    // Level 0.5 → 0.1 at sample 64 of the next block.
    p = next(s);
    s.process(1, silence(), [{ offset: 64, kind: EVENT.PARAM, id: 2, value: 0.1 }]);
    out = (await p).channels[0];
    expect(Math.max(...out.slice(0, 64).map(Math.abs))).toBeGreaterThan(0.4);
    expect(Math.max(...out.slice(64).map(Math.abs))).toBeLessThan(0.11);
    p = next(s);
    s.process(2, silence(), [{ offset: 0, kind: EVENT.ALL_NOTES_OFF }]);
    out = (await p).channels[0];
    expect(Math.max(...out.map(Math.abs))).toBe(0);
    s.close();
  });

  it("says when the plugin's own controls move: value, gesture, state changed", async () => {
    const s = new PlugHostSession(host!);
    await s.load({ path: fixtures, id: 'org.openband.fixture.synth' });
    const got: string[] = [];
    s.on('gesture', (g) => got.push(`gesture ${g.id} ${g.begin}`));
    s.on('param', (v) => got.push(`param ${v.id} ${v.value}`));
    const dirty = new Promise<void>((r) => s.once('dirty', () => r()));
    const p = next(s);
    s.process(0, [new Float32Array(128), new Float32Array(128)], [{ offset: 0, kind: EVENT.NOTE_ON, key: 127, value: 1 }]);
    await p;
    await dirty;
    expect(got).toEqual(['gesture 2 true', 'param 2 0.25', 'gesture 2 false']);
    expect(await s.values()).toEqual([{ id: 2, value: 0.25 }]);
    expect((await s.getState()).toString()).toMatch(/^gain=0\.25/);
    s.close();
  });

  it('says when a plugin has no window of its own', async () => {
    const s = new PlugHostSession(host!);
    await s.load({ path: fixtures, id: 'org.openband.fixture.gain' });
    expect(await s.openGui('Gain')).toEqual({ open: false, supported: false });
    s.close();
  });
});

const vital = '/Library/Audio/Plug-Ins/CLAP/Vital.clap';
describe.skipIf(!ready || !fs.existsSync(vital))('a real CLAP instrument (Vital, when installed)', () => {
  it('plays a note', async () => {
    const s = new PlugHostSession(host!);
    const info = await s.load({ path: vital, id: 'audio.vital.synth' });
    expect(info.params.length).toBeGreaterThan(100);
    let peak = 0;
    for (let k = 0; k < 120; k++) {
      const p = next(s);
      s.process(k, [new Float32Array(128), new Float32Array(128)], k === 0 ? [{ offset: 0, kind: EVENT.NOTE_ON, key: 60, value: 0.9 }] : []);
      peak = Math.max(peak, ...(await p).channels[0].map(Math.abs));
    }
    expect(peak).toBeGreaterThan(0.05);
    s.close();
  }, 30000);
});
