// openband-plughost against its test fixtures (G8.2). Needs the host built:
//   cmake -S native/plughost -B build/plughost && cmake --build build/plughost
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AU, EVENT, PlugHostSession, clapDirs, findBundles, hostBinary, pluginDirs, scanBundle, scanPlugins, vst3Dirs } from './plughost.mjs';

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
    const r = await scanPlugins({ host: host!, dirs: [build], audioUnits: false, timeoutMs: 1500 });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.plugins.map((p) => p.id)).toContain('org.openband.fixture.gain');
    expect(r.failed).toEqual([{ path: hang, reason: 'did not answer in 2 s' }]);
  }, 20000);

  it('caches by modification time and retries the ignored bundle on request', async () => {
    const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clapcache-')), 'plugins.json');
    await scanPlugins({ host: host!, dirs: [build], audioUnits: false, timeoutMs: 1000, cacheFile });
    const t0 = Date.now();
    const again = await scanPlugins({ host: host!, dirs: [build], audioUnits: false, timeoutMs: 1000, cacheFile });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(again.failed.length).toBe(1);
    const retried = await scanPlugins({ host: host!, dirs: [build], audioUnits: false, timeoutMs: 1000, cacheFile, retry: [hang] });
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

// G8.5: VST3 through the same host and protocol, with the VST3 test plugins (test/vst3fixtures.cpp).
const vst3 = path.join(build, 'ob-vst3-fixtures.vst3');
const GAIN3 = '0B5E00014F70656E42616E644761696E';
const SYNTH3 = '0B5E00034F70656E42616E6453796E74';
describe.skipIf(!host || !fs.existsSync(vst3))('openband-plughost with VST3 plugins', () => {
  it('finds .vst3 bundles in the VST3 folders and scans them', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vst3dirs-'));
    fs.mkdirSync(path.join(d, 'Vendor', 'Reverb.vst3', 'Contents', 'x86_64-win'), { recursive: true });
    fs.writeFileSync(path.join(d, 'Vendor', 'Reverb.vst3', 'Contents', 'x86_64-win', 'Reverb.vst3'), '');
    expect(findBundles([d]).map((p) => path.relative(d, p))).toEqual([path.join('Vendor', 'Reverb.vst3')]);
    fs.rmSync(d, { recursive: true });
    expect(vst3Dirs('darwin', {}, '/Users/x')).toEqual(['/Users/x/Library/Audio/Plug-Ins/VST3', '/Library/Audio/Plug-Ins/VST3']);
    expect(vst3Dirs('linux', {}, '/home/x')).toEqual(['/home/x/.vst3', '/usr/lib/vst3', '/usr/local/lib/vst3']);
    expect(vst3Dirs('win32', { COMMONPROGRAMFILES: 'C:\\CPF' }, 'C:\\Users\\x')[0]).toMatch(/CPF.VST3$/);
    expect(pluginDirs('linux', {}, '/home/x')).toEqual([...clapDirs('linux', {}, '/home/x'), ...vst3Dirs('linux', {}, '/home/x')]);
    const list = await scanBundle(host!, vst3);
    expect(list.map((p) => [p.format, p.id, p.name, p.kind])).toEqual([
      ['vst3', GAIN3, 'OB VST3 Gain', 'effect'],
      ['vst3', SYNTH3, 'OB VST3 Synth', 'instrument'],
    ]);
  });

  it('runs an effect: gain, its latency, parameters, state', async () => {
    const s = new PlugHostSession(host!);
    const info = await s.load({ path: vst3, id: GAIN3, sampleRate: 48000, maxBlock: 128 });
    expect(info).toMatchObject({ name: 'OB VST3 Gain', latency: 256, inputs: 2, outputs: 2, gui: false });
    expect(info.params).toEqual([expect.objectContaining({ id: 0, name: 'Gain', min: 0, max: 1, default: 0.5, value: 0.5 })]);
    const run = async (from: number, blocks: number, x: number) => {
      const outs: number[] = [];
      for (let k = 0; k < blocks; k++) {
        const p = next(s);
        s.process(from + k, blockOf(128, () => x));
        outs.push(...(await p).channels[0]);
      }
      return outs;
    };
    let out = await run(0, 3, 0.8);
    expect(out[255]).toBe(0); // 256 samples late, as it says
    expect(out[256]).toBeCloseTo(0.4, 6);
    s.setParam(0, 0.25);
    out = await run(3, 3, 0.8);
    expect(out.at(-1)).toBeCloseTo(0.2, 6);
    const state = await s.getState();
    // [u32 component size][component: Gain as a double][controller]
    expect(state.readUInt32LE(0)).toBe(8);
    expect(state.readDoubleLE(4)).toBe(0.25);
    const muted = Buffer.from(state);
    muted.writeDoubleLE(0, 4);
    expect(await s.setState(muted)).toBe(true);
    out = await run(6, 3, 0.8);
    expect(out.at(-1)).toBe(0);
    expect(await s.setState(state)).toBe(true);
    out = await run(9, 3, 0.8);
    expect(out.at(-1)).toBeCloseTo(0.2, 6);
    expect(await s.values()).toEqual([{ id: 0, value: 0.25 }]);
    expect(await s.openGui('Gain')).toEqual({ open: false, supported: false });
    s.close();
  });

  it('plays notes and parameter changes on their exact sample, and offline', async () => {
    const s = new PlugHostSession(host!);
    const info = await s.load({ path: vst3, id: SYNTH3 });
    expect(info).toMatchObject({ inputs: 0, outputs: 2, latency: 0 });
    const silence = () => [new Float32Array(128), new Float32Array(128)];
    let p = next(s);
    s.process(0, silence(), [{ offset: 37, kind: EVENT.NOTE_ON, key: 69, value: 1 }]);
    let out = (await p).channels[0];
    expect(out.findIndex((v) => v !== 0)).toBe(38);
    p = next(s);
    s.process(1, silence(), [{ offset: 64, kind: EVENT.PARAM, id: 2, value: 0.1 }]);
    out = (await p).channels[0];
    expect(Math.max(...out.slice(0, 64).map(Math.abs))).toBeGreaterThan(0.4);
    expect(Math.max(...out.slice(64).map(Math.abs))).toBeLessThan(0.11);
    p = next(s);
    s.process(2, silence(), [{ offset: 0, kind: EVENT.ALL_NOTES_OFF }]);
    expect(Math.max(...(await p).channels[0].map(Math.abs))).toBe(0);
    // Offline (exports): the same notes give the same samples.
    s.setRenderMode(true);
    const render = async () => {
      const r: number[] = [];
      for (let k = 0; k < 4; k++) {
        const q = next(s);
        s.process(10 + k, silence(), k === 0 ? [{ offset: 5, kind: EVENT.NOTE_ON, key: 60, value: 1 }] : k === 3 ? [{ offset: 0, kind: EVENT.ALL_NOTES_OFF }] : []);
        r.push(...(await q).channels[0]);
      }
      return r;
    };
    const a = await render();
    expect(a).toEqual(await render());
    s.close();
  });

  it('a VST3 that is not in the bundle: says so', async () => {
    const s = new PlugHostSession(host!);
    await expect(s.load({ path: vst3, id: '00000000000000000000000000000000' })).rejects.toThrow(/cannot create|not found|no class/i);
  });
});

// Third-party VST3s, when installed on this computer (never on CI).
for (const [file, kind] of [['/Library/Audio/Plug-Ins/VST3/ValhallaSupermassive.vst3', 'effect'], ['/Library/Audio/Plug-Ins/VST3/Vital.vst3', 'instrument']] as const) {
  describe.skipIf(!host || !fs.existsSync(file))(`a real VST3 ${kind} (${path.basename(file)}, when installed)`, () => {
    it(kind === 'effect' ? 'processes audio, with its state' : 'plays a note, with its state', async () => {
      const [p0] = (await scanBundle(host!, file)).filter((p) => p.kind === kind);
      const s = new PlugHostSession(host!);
      const info = await s.load({ path: file, id: p0.id });
      expect(info.params.length).toBeGreaterThan(10);
      let peak = 0;
      for (let k = 0; k < 120; k++) {
        const p = next(s);
        const x = kind === 'effect' ? blockOf(128, (i) => (k === 0 && i === 0 ? 1 : 0)) : [new Float32Array(128), new Float32Array(128)];
        s.process(k, x, kind === 'instrument' && k === 0 ? [{ offset: 0, kind: EVENT.NOTE_ON, key: 60, value: 0.9 }] : []);
        peak = Math.max(peak, ...(await p).channels[0].slice(k === 0 ? 1 : 0).map(Math.abs));
      }
      expect(peak).toBeGreaterThan(kind === 'effect' ? 1e-4 : 0.05);
      const state = await s.getState();
      expect(state.length).toBeGreaterThan(16);
      expect(await s.setState(state)).toBe(true);
      s.close();
    }, 30000);
  });
}

// G8.6: Audio Units (macOS), from the system's registry, with Apple's own AUs (on every Mac).
describe.skipIf(!host || process.platform !== 'darwin')('openband-plughost with Audio Units', () => {
  const silence = () => [new Float32Array(128), new Float32Array(128)];
  type Block = [Float32Array[], Parameters<PlugHostSession['process']>[2]?];
  const run = async (s: PlugHostSession, from: number, n: number, blocks: (k: number) => Block) => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const [x, ev] = blocks(k);
      const p = next(s);
      s.process(from + k, x, ev ?? []);
      out.push(...(await p).channels[0]);
    }
    return out;
  };

  it('lists the effects and instruments of the registry, without loading them', async () => {
    const { plugins } = await scanPlugins({ host: host!, dirs: [], audioUnits: true });
    const apple = plugins.filter((p) => p.format === 'au' && p.vendor === 'Apple');
    expect(apple.find((p) => p.id === 'aufx:dely:appl')).toMatchObject({ name: 'AUDelay', kind: 'effect', path: AU });
    expect(apple.find((p) => p.id === 'aumu:dls :appl')).toMatchObject({ name: 'DLSMusicDevice', kind: 'instrument' });
  });

  it('runs an effect to the sample: its latency, parameters on their sample, state', async () => {
    const s = new PlugHostSession(host!);
    const info = await s.load({ path: AU, id: 'aufx:lmtr:appl', sampleRate: 48000, maxBlock: 128 });
    expect(info).toMatchObject({ name: 'AUPeakLimiter', inputs: 2, outputs: 2, gui: true });
    const impulse = () => { const a = new Float32Array(128); a[5] = 0.5; return [a, a.slice()]; };
    const out = await run(s, 0, 3, (k) => [k === 0 ? impulse() : silence()]);
    expect(out.findIndex((v) => v !== 0)).toBe(5 + info.latency); // as late as it says
    s.close();

    const d = new PlugHostSession(host!);
    const di = await d.load({ path: AU, id: 'aufx:sdly:appl', sampleRate: 48000, maxBlock: 128 });
    expect(di.params[0]).toMatchObject({ id: 0, min: 0, max: 4410, default: 0 }); // the AU's own range
    // Delay 0 → 10 frames at sample 64 of the block: an impulse at 70 comes out at 80.
    const x = new Float32Array(128);
    x[20] = 1;
    x[70] = 1;
    const o = await run(d, 0, 1, () => [[x, x.slice()], [{ offset: 64, kind: EVENT.PARAM, id: 0, value: 10 }]]);
    expect([...o.keys()].filter((i) => o[i] > 0.5)).toEqual([20, 80]);
    const state = await d.getState();
    expect(state.subarray(0, 8).toString()).toBe('bplist00');
    d.setParam(0, 0);
    expect(await d.setState(state)).toBe(true);
    expect(await d.values()).toEqual([{ id: 0, value: 10 }]);
    d.close();
  });

  it('plays an instrument from notes on their sample, and offline the same twice', async () => {
    const s = new PlugHostSession(host!);
    const info = await s.load({ path: AU, id: 'aumu:dls :appl' });
    expect(info).toMatchObject({ inputs: 0, outputs: 2 });
    const notes = (k: number): Block => [silence(), k === 0 ? [{ offset: 40, kind: EVENT.NOTE_ON, key: 60, value: 0.9 }] : k === 20 ? [{ offset: 0, kind: EVENT.ALL_NOTES_OFF }] : []];
    const live = await run(s, 0, 30, notes);
    expect(live.findIndex((v) => v !== 0)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...live.map(Math.abs))).toBeGreaterThan(0.05);
    s.close();
    const render = async () => {
      const r = new PlugHostSession(host!);
      await r.load({ path: AU, id: 'aumu:dls :appl' });
      r.setRenderMode(true);
      const o = await run(r, 0, 30, notes);
      r.close();
      return o;
    };
    expect(await render()).toEqual(await render());
  });

  it('says when an Audio Unit is not there', async () => {
    const s = new PlugHostSession(host!);
    await expect(s.load({ path: AU, id: 'aufx:nope:none' })).rejects.toThrow(/not an Audio Unit id|cannot create/);
  });
});

// G8.7: low-latency monitoring — the host plays the plugin on an audio output of its own. On the null
// device everywhere (real timing, no sound); on this computer's real output, muted, with
// OPENBAND_TEST_REAL_AUDIO=1 — there the spec's bound holds: key → sound ≤ the device buffer + 2 blocks.
describe.skipIf(!ready)('low-latency monitoring', () => {
  const silence = () => [new Float32Array(128), new Float32Array(128)];
  const play = async (s: PlugHostSession, n: number) => {
    const got: { wait: number; offset: number; buffer: number; total: number }[] = [];
    const on = (h: (typeof got)[0]) => got.push(h);
    s.on('heard', on);
    for (let k = 0; k < n; k++) {
      await new Promise((r) => setTimeout(r, 23 + ((k * 7) % 19)));
      s.live({ kind: EVENT.NOTE_ON, key: 60 + k, value: 1 });
      // Held long enough to reach a period even when the machine is busy (on and off in the same period sound nothing).
      await new Promise((r) => setTimeout(r, 80));
      s.live({ kind: EVENT.NOTE_OFF, key: 60 + k });
    }
    await new Promise((r) => setTimeout(r, 300));
    s.off('heard', on);
    return got;
  };

  it('plays live notes on its own output; the blocks come back silent meanwhile, and not after', async () => {
    const s = new PlugHostSession(host!);
    await s.load({ path: fixtures, id: 'org.openband.fixture.synth' });
    const info = await s.monitor({ on: true, period: 64, nullDevice: true });
    expect(info).toMatchObject({ on: true, backend: 'Null', period: 64, periods: 2 });
    const heard = await play(s, 6);
    expect(heard).toHaveLength(6);
    for (const h of heard) {
      expect(h.buffer).toBe(128);
      expect(h.offset).toBeLessThanOrEqual(1); // on the first sample of its piece (sin(0) is 0)
      expect(h.total).toBe(h.wait + h.offset + h.buffer);
    }
    let p = next(s);
    s.process(0, silence(), [{ offset: 0, kind: EVENT.NOTE_ON, key: 69, value: 1 }]);
    expect(Math.max(...(await p).channels[0].map(Math.abs))).toBe(0);
    expect(await s.monitor({ on: false })).toEqual({ on: false });
    p = next(s);
    s.process(1, silence(), [{ offset: 0, kind: EVENT.NOTE_ON, key: 69, value: 1 }]);
    expect(Math.max(...(await p).channels[0].map(Math.abs))).toBeGreaterThan(0.3);
    s.close();
  });

  it.skipIf(process.env.OPENBAND_TEST_REAL_AUDIO !== '1')('on the real output: a key is heard within the device buffer + 2 blocks', async () => {
    const s = new PlugHostSession(host!);
    await s.load({ path: fixtures, id: 'org.openband.fixture.synth' });
    for (const period of [64, 128]) {
      const info = await s.monitor({ on: true, period, gain: 0 });
      expect(info.on).toBe(true);
      const heard = await play(s, 8);
      expect(heard.length).toBe(8);
      const buffer = info.period! * info.periods!;
      for (const h of heard) expect(h.total).toBeLessThanOrEqual(buffer + 2 * 128);
      console.log(`${info.backend} ${info.device}: period ${period}, key → sound ${heard.map((h) => h.total).join(' ')} frames (bound ${buffer + 256})`);
      await s.monitor({ on: false });
    }
    s.close();
  }, 30000);
});
