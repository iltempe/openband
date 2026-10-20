#!/usr/bin/env node
// End-to-end checks in a real Chrome, against the built studio served by `openband start`:
//   first-run  — from a fresh profile, "Surprise me" is playing in under 3 s; the tour ignores wrong actions
//   pwa        — installable (no installability errors), and offline after the first visit the app opens and plays
//   selfhost   — under the Docker CSP with a config.json: audio, features, no violations
//   remote     — OPENBAND_REMOTE_MCP=1: an MCP client over HTTP pairs with the tab's code and drives it
//   automation — a filter sweep on a WAM plugin: live and export within 1 dB per 100 ms
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
const launch = () => puppeteer.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });

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
    check(tabs.length > 0 && !tabs.some((t) => /API key/.test(t)), `features.byoKey=false hides the API key tab (tabs: ${tabs.join(', ')})`);
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
    check(await p.evaluate(() => !!document.querySelector('.ca-paired') || !document.querySelector('.ca-code')), 'the tab says it is paired');
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

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(tests);
for (const name of wanted) {
  console.log(`— ${name}`);
  await tests[name]();
}
process.exit(failed ? 1 : 0);
