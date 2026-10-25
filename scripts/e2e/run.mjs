#!/usr/bin/env node
// End-to-end checks in a real Chrome, against the built studio served by `openband start`:
//   first-run  — from a fresh profile, "Surprise me" is playing in under 3 s; the tour ignores wrong actions
//   pwa        — installable (no installability errors), and offline after the first visit the app opens and plays
//   selfhost   — under the Docker CSP with a config.json: audio, features, no violations
//   remote     — OPENBAND_REMOTE_MCP=1: an MCP client over HTTP pairs with the tab's code and drives it
//   automation — a filter sweep on a WAM plugin: live and export within 1 dB per 100 ms
//   master     — the master chain meets −14 LUFS / −1 dBTP, live = export, sidechain kick → bass
//   pilot      — the mix pilot: amount 0 changes nothing, 1 twice is idempotent, roles kept, stems = master
//   pdc        — plugin delay compensation: a track behind a 512-sample plugin stays aligned, live and exported
//   frozen     — a song with a native plugin opened in the browser plays its render cache, live and exported
//
//   node scripts/e2e/run.mjs [first-run|pwa ...]   (CHROME=/path/to/chrome, default: the system Chrome)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 7797;
const URL = `http://127.0.0.1:${PORT}/`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome =
  process.env.CHROME ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('No Chrome found: set CHROME');
  process.exit(2);
}
let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
};

function server(env = {}) {
  const p = spawn(process.execPath, [path.join(root, 'bin', 'openband.mjs'), 'start'], { env: { ...process.env, OPENBAND_PORT: String(PORT), OPENBAND_OPEN_BROWSER: '0', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve) => p.stderr.on('data', (d) => String(d).includes('bridge on') && resolve(p)));
}
// A fake audio output: the audio clock runs the same with or without (or with a stalled) sound device.
// Chrome sometimes takes long to start on a busy runner: wait longer, and try again.
const launch = async (tries = 3) => {
  try {
    return await puppeteer.launch({ executablePath: chrome, headless: true, timeout: 60000, args: [
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
        '--disable-audio-output',
        // Offline renders yield through timers: a page Chrome thinks is in the background must not be slowed down.
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ] });
  } catch (e) {
    if (tries <= 1) throw e;
    console.log(`  (Chrome did not start: ${e.message.split('\n')[0]}; trying again)`);
    return launch(tries - 1);
  }
};

const tests = {
  async 'first-run'() {
    const srv = await server();
    const b = await launch();
    try {
      const ctx = await b.createBrowserContext();
      const p = await ctx.newPage();
      await p.setViewport({ width: 1440, height: 900 });
      await p.goto(URL, { waitUntil: 'networkidle0' });
      const t0 = Date.now();
      await p.evaluate(() => document.querySelector('.welcome-choice').click());
      await p.waitForSelector('.t-play.on', { timeout: 5000 });
      const ms = Date.now() - t0;
      check(ms < 3000, `Surprise me → playing in ${ms} ms (< 3000)`);
      await wait(300);
      const step = () => p.evaluate(() => document.querySelector('.tour-card b')?.textContent ?? '');
      const s1 = await step();
      await p.keyboard.press('x');
      await wait(200);
      check(s1 !== '' && (await step()) === s1, `the tour waits for its action (still "${s1}" after opening the mixer)`);
    } finally {
      await b.close();
      srv.kill();
    }
  },
  async pwa() {
    let srv = await server();
    const b = await launch();
    try {
      const p = await b.defaultBrowserContext().newPage();
      await p.goto(URL, { waitUntil: 'networkidle0' });
      await p.evaluate(() => navigator.serviceWorker.ready);
      await wait(1000);
      const cdp = await p.createCDPSession();
      const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
      check(installabilityErrors.length === 0, `installable (${JSON.stringify(installabilityErrors)})`);
      srv.kill();
      srv = null;
      await p.setOfflineMode(true);
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForSelector('.welcome-choice', { timeout: 8000 });
      await p.evaluate(() => document.querySelector('.welcome-choice').click());
      const playing = await p.waitForSelector('.t-play.on', { timeout: 5000 }).then(() => true, () => false);
      check(playing, 'offline: the app opens and plays');
    } finally {
      await b.close();
      srv?.kill();
    }
  },
};

tests.selfhost = async () => {
  // A public instance: the Docker CSP and a config.json that turns the in-browser chat off.
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'ob-e2e-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ instanceName: 'Music lab', features: { byoKey: false } }));
  const srv = await server({ OPENBAND_CSP: '1', OPENBAND_CONFIG: cfg });
  const b = await launch();
  try {
    const p = await (await b.createBrowserContext()).newPage();
    const violations = [];
    p.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && !/7798\/bridge/.test(m.text()) && violations.push(m.text().slice(0, 200)));
    // ?mcp= an unused port: no AI connected, so the Connect AI wizard shows its tabs.
    const res = await p.goto(`${URL}?mcp=7798`, { waitUntil: 'networkidle0' });
    check(!!res.headers()['content-security-policy'], 'the page is served with a CSP');
    check((await p.title()).startsWith('Music lab'), `config.json applied (title "${await p.title()}")`);
    await p.evaluate(() => document.querySelector('.welcome-choice').click());
    check(await p.waitForSelector('.t-play.on', { timeout: 5000 }).then(() => true, () => false), 'audio plays under the CSP (worklets, workers)');
    await p.evaluate(() => document.querySelector('.ai-pill').click());
    await wait(300);
    const tabs = await p.evaluate(() => [...document.querySelectorAll('.ca-tabs button')].map((b) => b.textContent));
    check(tabs.length > 0 && !tabs.some((t) => /AI model|API key/.test(t)), `features.byoKey=false hides the API key tab (tabs: ${tabs.join(', ')})`);
    const catalog = await p.evaluate(async () => (await fetch('https://www.webaudiomodules.com/community/plugins.json')).ok).catch(() => false);
    check(catalog, 'the plugin catalog is reachable under the CSP');
    check(violations.length === 0, `no CSP violations${violations.length ? `: ${violations.join(' | ')}` : ''}`);
  } finally {
    await b.close();
    srv.kill();
  }
};

tests.remote = async () => {
  // OPENBAND_REMOTE_MCP=1: the tab shows a code, an MCP client over Streamable HTTP pairs and drives that tab.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  // Under the Docker CSP, as it would run in production.
  const srv = await server({ OPENBAND_REMOTE_MCP: '1', OPENBAND_HOST: '127.0.0.1', OPENBAND_CSP: '1' });
  const b = await launch();
  try {
    const p = await (await b.createBrowserContext()).newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(`${URL}?mcp=7798`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.querySelector('.welcome-choice').click());
    await p.waitForSelector('.t-play.on', { timeout: 5000 });
    await p.evaluate(() => document.querySelector('.ai-pill').click());
    const code = await p.waitForFunction(() => /^\d{3} \d{3}$/.test(document.querySelector('.ca-code')?.textContent ?? '') && document.querySelector('.ca-code').textContent, { timeout: 5000 }).then((h) => h.jsonValue(), () => null);
    check(!!code, `the "Claude (remote)" tab shows a code (${code})`);
    if (process.env.E2E_SHOTS) await p.screenshot({ path: path.join(process.env.E2E_SHOTS, 'remote-mcp.png') });
    const name = await p.evaluate(() => document.querySelector('.project-name, .t-name')?.textContent ?? null);
    const c = new Client({ name: 'e2e', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new globalThis.URL(`${URL}mcp`)));
    const before = await c.callTool({ name: 'get_project', arguments: {} });
    check(before.isError === true, 'no tool works before pairing');
    const r = await c.callTool({ name: 'pair_studio', arguments: { code } });
    check(!r.isError, 'pair_studio with the code from the tab');
    const proj = JSON.parse((await c.callTool({ name: 'get_project', arguments: {} })).content[0].text);
    check(Array.isArray(proj.tracks) && proj.tracks.length > 0 && (!name || proj.name === name), `get_project returns this tab's song ("${proj.name}", ${proj.tracks?.length} tracks)`);
    await c.callTool({ name: 'set_tempo', arguments: { bpm: 133 } });
    check((await p.evaluate(() => document.body.innerText.includes('133'))) === true, 'set_tempo from the remote client changes the tab');
    const paired = await p.waitForFunction(() => !!document.querySelector('.ca-paired') || !document.querySelector('.ca-code'), { timeout: 3000 }).then(() => true, () => false);
    const state = paired ? '' : ` — ${await p.evaluate(() => document.querySelector('.connect-ai')?.textContent?.slice(0, 160) ?? 'no wizard')}`;
    check(paired, `the tab says it is paired${state}`);
    await c.close();
  } finally {
    await b.close();
    srv.kill();
  }
};

tests.automation = async () => {
  // F22: a filter sweep automated on a WAM plugin sounds the same live and in the export (RMS per 100 ms < 1 dB).
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const c = new Client({ name: 'e2e', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server', 'mcp-server.mjs')], env: { ...process.env, OPENBAND_PORT: String(PORT), OPENBAND_OPEN_BROWSER: '0', OPENBAND_NO_UPDATE_CHECK: '1' }, stderr: 'ignore' }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
  const b = await launch();
  try {
    const p = await (await b.createBrowserContext()).newPage();
    await p.goto(`${URL}?debug`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.querySelector('.welcome-choice').click());
    await p.waitForSelector('.t-play.on', { timeout: 5000 });
    await p.keyboard.press('Space');
    await call('new_project', { name: 'Sweep', bpm: 120 });
    // A square wave: no detuned oscillators whose random phase would differ between live and export.
    const { track_id } = await call('add_track', { kind: 'instrument', instrument: 'chip' });
    await call('add_region', { track_id, start_bar: 1, length_bars: 4, notes: [{ pitch: 'C3', start: 0, duration: 16, velocity: 0.7 }, { pitch: 'G3', start: 0, duration: 16, velocity: 0.6 }] });
    await call('update_track', { track_id, reverb: 0, delay: 0 });
    const plugin = (await call('search_plugins', { description: 'GraphicEqualizer', kind: 'effect' })).matches[0];
    await call('add_plugin_effect', { track_id, plugin: plugin.id });
    let list;
    for (let i = 0; i < 40; i++) {
      list = await call('list_automatable', { track_id });
      if (list.plugins.length) break;
      await wait(500);
    }
    const freq = list.plugins.find((x) => /frequency/i.test(x.label));
    check(!!freq, `list_automatable shows the plugin's parameters (${list.plugins.length})`);
    await call('set_automation', { track_id, target: freq.target, points: [{ bar: 1, value: 40 }, { bar: 4.5, value: 3000 }] });
    const r = await p.evaluate(async () => {
      const { engine, useStore, renderBuffer } = window.openband;
      engine.position = 0;
      const cap = engine.captureMaster(9);
      await engine.play();
      const live = await cap;
      engine.stop();
      const proj = useStore.getState().project;
      const off = await renderBuffer(proj, { fromBeat: 0, toBeat: 16, tailSeconds: 1 });
      const flat = structuredClone(proj);
      flat.tracks.forEach((t) => delete t.automation);
      const offFlat = await renderBuffer(flat, { fromBeat: 0, toBeat: 16, tailSeconds: 1 });
      const mono = (a, b2) => Float32Array.from(a, (v, i) => (v + b2[i]) / 2);
      const first = (x) => x.findIndex((v) => Math.abs(v) > 1e-3);
      const win = (x, sr) => { const n = Math.floor(sr * 0.1), out = [], f = first(x); for (let i = f; i + n <= x.length; i += n) { let s = 0; for (let k = 0; k < n; k++) s += x[i + k] ** 2; out.push(10 * Math.log10(s / n + 1e-12)); } return out; };
      const L = win(mono(live.channels[0], live.channels[1]), live.sampleRate);
      const O = win(mono(off.getChannelData(0), off.getChannelData(1)), off.sampleRate);
      const F = win(mono(offFlat.getChannelData(0), offFlat.getChannelData(1)), offFlat.sampleRate);
      const cmp = (A, B) => { const d = []; for (let i = 2; i < 72; i++) if (A[i] > -60 && B[i] > -60) d.push(Math.abs(A[i] - B[i])); return { max: Math.max(...d), mean: d.reduce((x, y) => x + y, 0) / d.length }; };
      return { same: cmp(L, O), control: cmp(L, F) };
    });
    check(r.same.max < 1, `the WAM filter sweep sounds the same live and exported (max ${r.same.max.toFixed(2)} dB, mean ${r.same.mean.toFixed(2)} dB per 100 ms)`);
    check(r.control.mean > 3, `…and the sweep is really there (without it the export differs by ${r.control.mean.toFixed(1)} dB)`);
  } finally {
    await b.close();
    await c.close();
  }
};

tests.master = async () => {
  // G1: the master chain meets a platform target (−14 LUFS, −1 dBTP) in the export, sounds the same live,
  // and a sidechain (kick → bass) ducks the bass even in a stem without the kick.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const c = new Client({ name: 'e2e', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server', 'mcp-server.mjs')], env: { ...process.env, OPENBAND_PORT: String(PORT), OPENBAND_OPEN_BROWSER: '0', OPENBAND_NO_UPDATE_CHECK: '1' }, stderr: 'ignore' }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
  const b = await launch();
  try {
    const p = await (await b.createBrowserContext()).newPage();
    await p.goto(`${URL}?debug`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.querySelector('.welcome-choice').click());
    await p.waitForSelector('.t-play.on', { timeout: 5000 });
    await p.keyboard.press('Space');
    await call('new_project', { name: 'Master', bpm: 120, key: 'Am' });
    const kick = (await call('add_track', { kind: 'drums', name: 'Kick' })).track_id;
    await call('add_drum_pattern', { track_id: kick, start_bar: 1, bars: 4, pattern: { kick: 'x...x...x...x...' } });
    const bass = (await call('add_track', { kind: 'instrument', instrument: 'chip', name: 'Bass' })).track_id;
    await call('add_region', { track_id: bass, start_bar: 1, length_bars: 4, notes: [{ pitch: 'A1', start: 0, duration: 16, velocity: 0.8 }] });
    const keys = (await call('add_track', { kind: 'instrument', instrument: 'chip', name: 'Keys' })).track_id;
    await call('add_region', { track_id: keys, start_bar: 1, length_bars: 4, notes: [{ pitch: 'A3', start: 0, duration: 16, velocity: 0.5 }, { pitch: 'E4', start: 0, duration: 16, velocity: 0.5 }] });
    for (const t of [kick, bass, keys]) await call('update_track', { track_id: t, reverb: 0, delay: 0 });
    await call('set_track_effects', { track_id: bass, compressor: { threshold: -30, ratio: 8, attack: 0.002, release: 0.08, makeup: 0, sidechain: { source_track_id: kick, amount: 1 } } });
    const res = await call('set_master_chain', { platform: 'spotify', glue: { threshold: -20, ratio: 2 }, width: { amount: 1.1 } });
    check(Math.abs(res.loudness.after_lufs + 14) <= 0.3 && res.loudness.true_peak_dbtp <= -0.95, `set_master_chain spotify: ${res.loudness.after_lufs} LUFS, ${res.loudness.true_peak_dbtp} dBTP (from ${res.loudness.before_lufs}, ${res.loudness.renders} renders)`);
    const r = await p.evaluate(async () => {
      const { engine, useStore, renderBuffer, analysis } = window.openband;
      const proj = useStore.getState().project;
      const off = await renderBuffer(proj, { sampleRate: 48000, tailSeconds: 1 });
      const chs = [off.getChannelData(0), off.getChannelData(1)];
      const lufs = analysis.loudness(chs, 48000).integrated;
      const tp = 20 * Math.log10(Math.max(analysis.truePeak(chs[0]), analysis.truePeak(chs[1])));
      // Live = export, on sustained parts (drum transients make 100 ms windows jitter by themselves, with
      // or without a master chain): the kick muted and the sidechain off, the chain and its limiter on.
      const stems = structuredClone(proj);
      useStore.getState().commit((d) => {
        d.tracks.find((t) => t.name === 'Kick').mute = true;
        delete d.tracks.find((t) => t.name === 'Bass').fx.comp.sidechain;
      });
      await new Promise((r) => setTimeout(r, 400));
      const sustained = await renderBuffer(useStore.getState().project, { sampleRate: 48000, tailSeconds: 1 });
      const sus = [sustained.getChannelData(0), sustained.getChannelData(1)];
      engine.position = 0;
      const cap = engine.captureMaster(8.5);
      await engine.play();
      const live = await cap;
      engine.stop();
      const mono = (a, b2) => Float32Array.from(a, (v, i) => (v + b2[i]) / 2);
      const first = (x) => x.findIndex((v) => Math.abs(v) > 1e-3);
      const win = (x, sr) => { const n = Math.floor(sr * 0.1), out = [], f = first(x); for (let i = f; i + n <= x.length; i += n) { let s = 0; for (let k = 0; k < n; k++) s += x[i + k] ** 2; out.push(10 * Math.log10(s / n + 1e-12)); } return out; };
      const L = win(mono(live.channels[0], live.channels[1]), live.sampleRate);
      const O = win(mono(sus[0], sus[1]), 48000);
      const d = [];
      for (let i = 2; i < 76; i++) if (L[i] > -60 && O[i] > -60) d.push(Math.abs(L[i] - O[i]));
      // The bass stem alone, with and without its sidechain: ducked on the kicks (every 0.5 s).
      const stem = async (proj2) => (await renderBuffer(proj2, { tracks: [proj2.tracks.find((t) => t.name === 'Bass').id], sampleRate: 48000, tailSeconds: 0 })).getChannelData(0);
      const withSc = await stem(stems);
      const flat = structuredClone(stems);
      delete flat.tracks.find((t) => t.name === 'Bass').fx.comp.sidechain;
      const without = await stem(flat);
      const rms = (x, from, len) => { let s = 0; for (let k = 0; k < len; k++) s += x[from + k] ** 2; return 10 * Math.log10(s / len + 1e-12); };
      const ducks = [];
      for (let k = 1; k < 7; k++) { const at = Math.round(k * 0.5 * 48000) + 480; ducks.push(rms(without, at, 2400) - rms(withSc, at, 2400)); }
      // The muted kick must be silent live (the M button once did nothing): no beat-rate peaks.
      const sorted = [...L.slice(2, 76)].sort((x, y) => x - y);
      const spread = sorted[sorted.length - 1] - sorted[Math.floor(sorted.length / 2)];
      return { spread, lufs, tp, liveMax: Math.max(...d), liveMean: d.reduce((a, x) => a + x, 0) / d.length, duck: ducks.reduce((a, x) => a + x, 0) / ducks.length };
    });
    check(Math.abs(r.lufs + 14) <= 0.3 && r.tp <= -0.95, `the export measures ${r.lufs.toFixed(2)} LUFS and ${r.tp.toFixed(2)} dBTP (target −14 / −1)`);
    check(r.spread < 2, `a muted track is silent live (level spread ${r.spread.toFixed(2)} dB over a sustained mix)`);
    check(r.liveMax < 1, `live sounds like the export through the master chain (max ${r.liveMax.toFixed(2)} dB, mean ${r.liveMean.toFixed(2)} dB per 100 ms)`);
    check(r.duck > 4, `the kick ducks the bass by ${r.duck.toFixed(1)} dB, also in a stem without the kick`);
  } finally {
    await b.close();
    await c.close();
  }
};

tests.pilot = async () => {
  // G1: the Mix & Master Pilot on the demo song, through MCP; then the export for platforms.
  const os = await import('node:os');
  const { unzipSync } = await import('fflate');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const c = new Client({ name: 'e2e', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server', 'mcp-server.mjs')], env: { ...process.env, OPENBAND_PORT: String(PORT), OPENBAND_OPEN_BROWSER: '0', OPENBAND_NO_UPDATE_CHECK: '1' }, stderr: 'ignore' }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
  const b = await launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-e2e-'));
  try {
    const p = await (await b.createBrowserContext()).newPage();
    await p.goto(`${URL}?debug`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.querySelector('.welcome-more .btn.primary').click());
    await wait(800);
    await p.evaluate(() => window.openband.engine.stop());
    // What the pilot touches: the mix of every track and the master.
    const mixState = () => p.evaluate(() => JSON.stringify((({ tracks, master }) => ({ tracks: tracks.map((t) => [t.id, t.volume, t.pan, t.reverb, t.delay, t.fx ?? null, t.role ?? null]), master: master ?? null }))(window.openband.useStore.getState().project)));
    const initial = await mixState();
    const notesBefore = await p.evaluate(() => (window.openband.useStore.getState().project.annotations ?? []).length);
    const r0 = await call('mix_pilot', { amount: 0, genre: 'pop', platform: 'spotify' });
    check((await mixState()) === initial && (await p.evaluate(() => (window.openband.useStore.getState().project.annotations ?? []).length)) === notesBefore, `amount 0 leaves the song as it was (${r0.changes.length} changes proposed, none applied)`);
    const tracks = (await call('get_project')).tracks;
    const keys = tracks.find((t) => /piano/i.test(t.name));
    await call('set_track_role', { track_id: keys.id, role: 'lead' });
    const withRole = await mixState();
    const r1 = await call('mix_pilot', { amount: 1, genre: 'pop', platform: 'spotify' });
    const full = await mixState();
    check(full !== initial && Math.abs(r1.loudness.after_lufs + 14) <= 0.3 && r1.loudness.true_peak_dbtp <= -0.95, `amount 1: ${r1.changes.length} changes, ${r1.loudness.before_lufs} → ${r1.loudness.after_lufs} LUFS, ${r1.loudness.true_peak_dbtp} dBTP`);
    check(r1.roles.find((x) => x.track_id === keys.id)?.role === 'lead', `the user's role is kept (${keys.name}: ${r1.roles.find((x) => x.track_id === keys.id)?.role}; ${r1.roles.map((x) => `${x.name}=${x.role}`).join(', ')})`);
    const r2 = await call('mix_pilot', { amount: 1, genre: 'pop', platform: 'spotify' });
    check((await mixState()) === full, `amount 1 twice in a row is idempotent (${r2.loudness.after_lufs} LUFS again)`);
    const half = await call('set_pilot_amount', { amount: 0.5 });
    const mid = await mixState();
    await call('set_pilot_amount', { amount: 0 });
    check(mid !== full && mid !== withRole && (await mixState()) === withRole, `the knob blends live (50%: ${half.loudness?.after_lufs} LUFS) and back to the song as it was at 0`);
    await call('set_pilot_amount', { amount: 1 });
    const ex = await call('export_for_platforms', { platforms: ['spotify', 'cd'], stems: true, versions: ['instrumental'], save_to: dir });
    const zip = unzipSync(fs.readFileSync(ex.saved));
    const names = Object.keys(zip);
    // Spotify's −14 is met; the CD's −9 is out of reach for this sparse song without crushing it, and the export says so.
    const sp = ex.platforms.find((x) => x.platform === 'spotify');
    const cd = ex.platforms.find((x) => x.platform === 'cd');
    check(sp.compliant && cd.true_peak_dbtp <= -0.45 && (cd.compliant || ex.notes?.some((n) => /CD|cd/.test(n))), `masters: ${ex.platforms.map((x) => `${x.platform} ${x.lufs} LUFS ${x.true_peak_dbtp} dBTP${x.compliant ? '' : ' (out of reach, noted)'}`).join(', ')}`);
    check(ex.stem_residual_db < -60, `the stems (${ex.stems.join(', ')}) add up to the master: residual ${ex.stem_residual_db} dB`);
    const wav = (n) => zip[names.find((x) => x.includes(n))];
    const bits = (w) => w[34] | (w[35] << 8);
    check(names.includes('report.txt') && bits(wav('spotify')) === 24 && bits(wav('cd')) === 16, `zip: ${names.length} files (${names.filter((n) => !n.startsWith('stems/')).join(', ')} + ${names.filter((n) => n.startsWith('stems/')).length} stems); 24-bit masters, 16-bit CD`);
    await call('fix_pilot');
    check(await p.evaluate(() => !window.openband.useStore.getState().project.pilot), 'fix_pilot keeps the result and ends the live knob');
  } finally {
    await b.close();
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

tests.pdc = async () => {
  // G8.1: two identical notes, one panned left through a plugin with 512 samples of latency (the
  // in-process test host, behind the block bridge live), one panned right: they line up within a sample.
  const srv = await server({ OPENBAND_NO_UPDATE_CHECK: '1' });
  const b = await launch();
  try {
    const p = await (await b.createBrowserContext()).newPage();
    await p.goto(`${URL}?debug`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.querySelector('.welcome-choice').click());
    await p.waitForSelector('.t-play.on', { timeout: 5000 });
    await p.keyboard.press('Space');
    const r = await p.evaluate(async () => {
      const { engine, useStore, renderBuffer, commands, native } = window.openband;
      await commands.new_project({ name: 'PDC', bpm: 120, key: 'C' });
      const a = (await commands.add_track({ kind: 'instrument', instrument: 'chip', name: 'Late' })).track_id;
      const c = (await commands.add_track({ kind: 'instrument', instrument: 'chip', name: 'Dry' })).track_id;
      for (const [id, pan] of [[a, -1], [c, 1]]) {
        await commands.add_region({ track_id: id, start_bar: 1, length_bars: 1, notes: [{ pitch: 'C4', start: 1, duration: 1, velocity: 0.8 }] });
        await commands.update_track({ track_id: id, pan, reverb: 0, delay: 0 });
      }
      useStore.getState().commit((d) => {
        const t = d.tracks.find((x) => x.id === a);
        t.fx = { amp: { on: false, drive: 0, tone: 0, level: 0.7 }, eq: { on: false, low: 0, mid: 0, high: 0, midFreq: 1000 }, comp: { on: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.18, makeup: 0 }, plugins: [native.testSlot('lat', 'org.openband.test.latency', { latency: 512 })] };
      });
      await new Promise((r) => setTimeout(r, 800));
      const onset = (x) => x.findIndex((v) => Math.abs(v) > 0.01);
      const off = await renderBuffer(useStore.getState().project, { sampleRate: 48000, tailSeconds: 0.5 });
      const exportDiff = onset(off.getChannelData(1)) - onset(off.getChannelData(0));
      const expected = Math.round(0.5 * 48000);
      const exportAt = onset(off.getChannelData(1));
      const live = async () => {
        engine.position = 0;
        const cap = engine.captureMaster(1.2);
        await engine.play();
        const got = await cap;
        engine.stop();
        await new Promise((r) => setTimeout(r, 300));
        return onset(got.channels[1]) - onset(got.channels[0]);
      };
      const liveDiff = await live();
      const pdcLatency = engine.pdcLatency;
      engine.pdcEnabled = false;
      engine.syncPdc();
      const rawDiff = await live();
      engine.pdcEnabled = true;
      engine.syncPdc();
      return { exportDiff, exportAt, expected, liveDiff, rawDiff, pdcLatency, sr: engine.sampleRate ?? 48000 };
    });
    check(Math.abs(r.exportDiff) <= 1 && Math.abs(r.exportAt - r.expected) <= 64, `export: the delayed track lines up with the dry one (${r.exportDiff} samples apart; both at sample ${r.exportAt}, the note's time ${r.expected})`);
    check(r.pdcLatency === 6 * 128 + 512, `live latency compensated: ${r.pdcLatency} samples (6 bridge blocks + 512)`);
    check(Math.abs(r.liveDiff) <= 1, `live: the two tracks line up (${r.liveDiff} samples apart)`);
    check(Math.abs(Math.abs(r.rawDiff) - r.pdcLatency) <= 1, `…and without compensation they would be ${Math.abs(r.rawDiff)} samples apart`);
  } finally {
    await b.close();
    srv.kill();
  }
};

tests.frozen = async () => {
  // G8.4: a track that plays a native plugin (CLAP), opened in a browser — where native plugins can't run —
  // plays its render cache: live and in the export, with a badge; after its notes change, "out of date".
  const srv = await server({ OPENBAND_NO_UPDATE_CHECK: '1' });
  const b = await launch();
  try {
    const p = await (await b.createBrowserContext()).newPage();
    await p.goto(`${URL}?debug`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.querySelector('.welcome-choice').click());
    await p.waitForSelector('.t-play.on', { timeout: 5000 });
    await p.keyboard.press('Space');
    const r = await p.evaluate(async () => {
      const { engine, useStore, renderBuffer, commands, freeze, samples, encodePcm } = window.openband;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await commands.new_project({ name: 'Frozen', bpm: 120, key: 'A' });
      // The frozen audio: 3 s of a 440 Hz sine at −12 dBFS (what the desktop app would have rendered).
      const sr = 48000;
      const sine = Float32Array.from({ length: sr * 3 }, (_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / sr));
      const wav = encodePcm([sine, sine], sr, 16);
      const info = await samples.importSample(wav.buffer.slice(0), 'Vital (frozen)', 'audio/wav');
      useStore.getState().commit((d) => void (d.instruments = [{ id: 'nat_v', name: 'Vital', kind: 'instrument', source: 'native', zones: [], attack: 0, release: 0, format: 'clap', native: { id: 'audio.vital.synth', path_hint: '/Library/Audio/Plug-Ins/CLAP/Vital.clap' } }]));
      const id = (await commands.add_track({ kind: 'instrument', name: 'Vital' })).track_id;
      useStore.getState().commit((d) => void (d.tracks.find((t) => t.id === id).instrument = 'nat_v'));
      await commands.add_region({ track_id: id, start_bar: 1, length_bars: 2, notes: [{ pitch: 'A4', start: 0, duration: 8, velocity: 0.9 }] });
      await commands.update_track({ track_id: id, reverb: 0, delay: 0 });
      useStore.getState().commit((d) => {
        const t = d.tracks.find((x) => x.id === id);
        t.frozen = { sampleId: info.id, hash: freeze.trackHash(d, t), plugins: ['Vital'], seconds: 3 };
      });
      await wait(800);
      const badge = document.querySelector('.frozen-badge');
      const badgeText = badge?.textContent ?? null;
      const rms = (x, from, to, rate) => {
        const a = x.subarray(Math.floor(from * rate), Math.floor(to * rate));
        let e = 0;
        for (const v of a) e += v * v;
        return 10 * Math.log10(e / a.length + 1e-12);
      };
      engine.position = 0;
      const cap = engine.captureMaster(2.2);
      await engine.play();
      const live = await cap;
      engine.stop();
      const liveRms = rms(live.channels[0], 0.5, 1.8, live.sampleRate);
      const exp = await renderBuffer(useStore.getState().project, { sampleRate: sr, tailSeconds: 0.2 });
      const exportRms = rms(exp.getChannelData(0), 0.5, 1.8, sr);
      await commands.add_region({ track_id: id, start_bar: 3, length_bars: 1, notes: [{ pitch: 'C5', start: 0, duration: 4, velocity: 0.9 }] });
      await wait(400);
      const stale = !!document.querySelector('.frozen-badge.stale');
      return { badgeText, liveRms, exportRms, sourceRms: rms(sine, 0.5, 1.8, sr), stale };
    });
    check(!!r.badgeText && /Frozen/.test(r.badgeText), `the native track shows it plays its render cache ("${r.badgeText?.trim()}")`);
    // Through the track's channel, like any instrument: the equal-power pan law (−3 dB) at the centre.
    check(Math.abs(r.liveRms - (r.sourceRms - 3.01)) < 0.5, `live, the render cache plays through the track (${r.liveRms.toFixed(1)} dB; the frozen audio ${r.sourceRms.toFixed(1)} dB, −3 dB centre pan)`);
    check(Math.abs(r.exportRms - r.liveRms) < 0.5, `the export plays it too (${r.exportRms.toFixed(1)} dB)`);
    check(r.stale, 'after the notes change, the badge says the frozen audio is out of date');
  } finally {
    await b.close();
    srv.kill();
  }
};

tests.ghosts = async () => {
  // G3: ghost notes in the piano roll — they appear after a pause, ⇧Tab shows the next, Esc dismisses, Tab
  // accepts as one undo step.
  const srv = await server({ OPENBAND_NO_UPDATE_CHECK: '1' });
  const b = await launch();
  try {
    const p = await (await b.createBrowserContext()).newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(`${URL}?debug`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.querySelector('.welcome-choice').click());
    await p.waitForSelector('.t-play.on', { timeout: 5000 });
    await p.evaluate(() => [...document.querySelectorAll('.tour-card button')].at(-1)?.click());
    await p.keyboard.press('Space');
    const ids = await p.evaluate(async () => {
      const { useStore, commands, ghost } = window.openband;
      await commands.new_project({ name: 'Ghosts', bpm: 96, key: 'Am' });
      const keys = (await commands.add_track({ kind: 'instrument', instrument: 'felt-piano', name: 'Keys' })).track_id;
      const chord = (names, bar) => names.map((pitch) => ({ pitch, start: 0, duration: 4, velocity: 0.6 })).map((n) => ({ ...n, start: (bar - 1) * 4 }));
      await commands.add_region({ track_id: keys, start_bar: 1, length_bars: 4, notes: [...chord(['A3', 'C4', 'E4'], 1), ...chord(['F3', 'A3', 'C4'], 2), ...chord(['C4', 'E4', 'G4'], 3), ...chord(['G3', 'B3', 'D4'], 4)] });
      const lead = (await commands.add_track({ kind: 'instrument', instrument: 'neon-lead', name: 'Lead' })).track_id;
      const r = await commands.add_region({ track_id: lead, start_bar: 1, length_bars: 4, notes: [{ pitch: 'A4', start: 0, duration: 1 }, { pitch: 'C5', start: 1, duration: 1 }, { pitch: 'E5', start: 2, duration: 1.5 }, { pitch: 'D5', start: 3.5, duration: 0.5 }, { pitch: 'C5', start: 4, duration: 1 }, { pitch: 'A4', start: 5, duration: 1 }] });
      useStore.getState().set({ selectedTrackId: lead, selectedRegionId: r.region_id, bottom: 'editor' });
      return { region: r.region_id, enabled: ghost.useGhost.getState().enabled };
    });
    const shown = await p.waitForSelector('.pr-suggest', { timeout: 4000 }).then(() => true, () => false);
    const tag1 = await p.$eval('.pr-suggest-tag b', (e) => e.textContent).catch(() => null);
    check(ids.enabled && shown && tag1 === '1/3', `after a pause the piano roll shows a suggestion in grey (${tag1})`);
    await p.click('.pr-suggest-why');
    const why = await p.$eval('.pr-suggest-explain', (e) => e.textContent).catch(() => '');
    check(/chord|accordo/i.test(why), `"?" says why (${why.trim().slice(0, 60)}…)`);
    // For the docs: E2E_SHOTS=dir saves what the piano roll looks like.
    if (process.env.E2E_SHOTS) await p.screenshot({ path: path.join(process.env.E2E_SHOTS, 'ghost-notes.png') });
    await p.keyboard.down('Shift');
    await p.keyboard.press('Tab');
    await p.keyboard.up('Shift');
    const tag2 = await p.$eval('.pr-suggest-tag b', (e) => e.textContent).catch(() => null);
    check(tag2 === '2/3', `⇧Tab shows the next one (${tag2})`);
    await p.keyboard.press('Escape');
    const gone = !(await p.$('.pr-suggest'));
    await new Promise((r) => setTimeout(r, 900));
    check(gone && !(await p.$('.pr-suggest')), 'Esc dismisses it, and it stays away until the region changes');
    await p.evaluate((id) => window.openband.commands.add_notes({ region_id: id, notes: [{ pitch: 'F4', start: 6, duration: 2 }] }), ids.region);
    const back = await p.waitForSelector('.pr-suggest', { timeout: 4000 }).then(() => true, () => false);
    const before = await p.evaluate((id) => window.openband.useStore.getState().project.regions.find((r) => r.id === id).notes.length, ids.region);
    await p.keyboard.press('Tab');
    const after = await p.evaluate((id) => window.openband.useStore.getState().project.regions.find((r) => r.id === id).notes.length, ids.region);
    await p.keyboard.down('Control');
    await p.keyboard.press('z');
    await p.keyboard.up('Control');
    const undone = await p.evaluate((id) => window.openband.useStore.getState().project.regions.find((r) => r.id === id).notes.length, ids.region);
    check(back && after > before && undone === before, `an edit brings a new one; Tab accepts it (${before} → ${after} notes) and one undo takes it back (${undone})`);
    // Harmonize, asked for right after an edit: the automatic suggestion must not replace it.
    await p.evaluate((id) => window.openband.commands.add_notes({ region_id: id, notes: [{ pitch: 'E4', start: 8, duration: 1 }] }), ids.region);
    await p.evaluate(() => [...document.querySelectorAll('.ghost-tools button')].find((x) => /Harmoni|Armonizza/.test(x.textContent))?.click());
    await new Promise((r) => setTimeout(r, 1000));
    const harmony = await p.$$eval('.pr-suggest.harmony', (x) => x.length);
    const tracksBefore = await p.evaluate(() => window.openband.useStore.getState().project.tracks.length);
    await p.keyboard.press('Tab');
    const added = await p.evaluate(() => window.openband.useStore.getState().project.tracks.at(-1).name);
    const tracksAfter = await p.evaluate(() => window.openband.useStore.getState().project.tracks.length);
    check(harmony > 0 && tracksAfter === tracksBefore + 1 && added === 'Harmony', `Harmonize shows the chords (${harmony} notes) and Tab puts them on a new "${added}" track`);
  } finally {
    await b.close();
    srv.kill();
  }
};

tests.arrange = async () => {
  // G2: an 8-bar loop and a drawn energy curve become a whole song, on a branch, in compare view.
  const srv = await server({ OPENBAND_NO_UPDATE_CHECK: '1' });
  const b = await launch();
  try {
    const p = await (await b.createBrowserContext()).newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(`${URL}?debug`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.querySelector('.welcome-choice').click());
    await p.waitForSelector('.t-play.on', { timeout: 5000 });
    await p.evaluate(() => [...document.querySelectorAll('.tour-card button')].at(-1)?.click());
    await p.keyboard.press('Space');
    const r = await p.evaluate(async () => {
      const { useStore, commands } = window.openband;
      await commands.new_project({ name: 'Loop', bpm: 100, key: 'Am' });
      const drums = (await commands.add_track({ kind: 'drums', name: 'Drums' })).track_id;
      await commands.add_drummer({ track_id: drums, from_bar: 1, to_bar: 8, style: 'pop' });
      const keys = (await commands.add_track({ kind: 'instrument', instrument: 'felt-piano', name: 'Keys' })).track_id;
      await commands.add_chord_progression({ track_id: keys, chords: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'], start_bar: 1 });
      const bass = (await commands.add_track({ kind: 'instrument', instrument: 'sub-bass', name: 'Bass' })).track_id;
      await commands.add_region({ track_id: bass, start_bar: 1, length_bars: 8, notes: [0, 1, 2, 3, 4, 5, 6, 7].map((bar) => ({ pitch: ['A1', 'F1', 'C2', 'G1'][bar % 4], start: bar * 4, duration: 3.5 })) });
      const before = JSON.stringify(useStore.getState().project.regions.filter((x) => !x.drummer).map((x) => [x.id, x.notes]));
      await commands.set_energy_curve({ shape: 'pop', length_bars: 48 });
      const a = await commands.arrange_from_energy({ seed: 3 });
      const proj = useStore.getState().project;
      const kept = JSON.parse(before).every(([id, notes]) => JSON.stringify(proj.regions.find((x) => x.id === id)?.notes) === JSON.stringify(notes));
      const fx = proj.tracks.find((t) => t.name === 'FX transitions');
      const audio = proj.regions.filter((x) => x.trackId === fx?.id);
      const energy = await commands.get_energy();
      await new Promise((r) => setTimeout(r, 500));
      return { branch: a.branch, sections: a.sections.map((s) => s.kind), r: a.follows_the_curve, kept, transitions: audio.length, sampled: audio.every((x) => !x.audio.sampleId.startsWith('transition:')), bars: energy.bars, compare: !!document.querySelector('.ver-banner') };
    });
    check(/^arrangement-\d+$/.test(r.branch ?? '') && r.compare, `the arrangement is on its own branch (${r.branch}), in compare view`);
    check(['intro', 'verse', 'chorus', 'outro'].every((k) => r.sections.includes(k)) && r.bars >= 48, `a whole song: ${r.sections.join(' · ')} (${r.bars} bars)`);
    check(r.r > 0.7, `it follows the drawn curve (correlation ${r.r})`);
    check(r.kept, "the user's notes are unchanged");
    check(r.transitions > 0 && r.sampled, `${r.transitions} transitions, rendered to samples on their own track`);
  } finally {
    await b.close();
    srv.kill();
  }
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(tests);
for (const name of wanted) {
  console.log(`— ${name}`);
  await tests[name]();
}
process.exit(failed ? 1 : 0);
