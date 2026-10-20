#!/usr/bin/env node
// Record docs/demo.gif: the built studio in Chrome, driven over MCP the way an AI client drives it —
// the welcome screen, then a song built track by track from one request, then playing with the mixer.
// With --shots it takes docs/mixer.png and docs/editor.png of the demo song instead.
//   npm run build && node scripts/record-demo.mjs [--shots]   (needs ffmpeg; CHROME=/path/to/chrome)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7795;
const W = 1280;
const H = 800;
const out = path.join(root, 'docs', 'demo.gif');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

const c = new Client({ name: 'demo', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server', 'mcp-server.mjs')], env: { ...process.env, OPENBAND_PORT: String(PORT), OPENBAND_OPEN_BROWSER: '0', OPENBAND_NO_UPDATE_CHECK: '1' }, stderr: 'ignore' }));
const log = (m) => process.env.DEMO_DEBUG && console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const T0 = Date.now();
const call = async (name, args = {}) => {
  log(name);
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};

log('connected');
const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
if (process.argv.includes('--shots')) {
  try {
    const p = await (await b.createBrowserContext()).newPage();
    await p.setViewport({ width: 1600, height: 1000 });
    await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('.welcome-choice');
    await p.evaluate(() => document.querySelector('.welcome-more .btn.primary').click());
    await wait(300);
    await p.evaluate(() => [...document.querySelectorAll('.tour-card button')].at(-1)?.click());
    const proj = await call('get_project');
    await call('transport', { action: 'play', from_bar: 2 });
    await p.keyboard.press('x');
    await wait(2500);
    await p.screenshot({ path: path.join(root, 'docs', 'mixer.png') });
    await call('transport', { action: 'stop' });
    const bassTrack = proj.tracks.find((t) => /bass/i.test(t.name));
    const region = bassTrack.regions[0];
    await call('open_editor', { region_id: region.id });
    await wait(800);
    await p.screenshot({ path: path.join(root, 'docs', 'editor.png') });
    console.log('docs/mixer.png, docs/editor.png');
  } finally {
    await b.close();
    await c.close();
  }
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-demo-'));
const frames = [];
let recording = true;
try {
  const p = await (await b.createBrowserContext()).newPage();
  await p.setViewport({ width: W, height: H });
  await p.goto(`http://127.0.0.1:${PORT}/?lang=en`, { waitUntil: 'networkidle0' });
  log('page loaded');
  await p.waitForSelector('.welcome-choice');
  log('welcome');
  await wait(800);

  // A screenshot loop, each frame with the time it was taken.
  const loop = (async () => {
    while (recording) {
      const file = path.join(dir, `f${String(frames.length).padStart(4, '0')}.png`);
      await p.screenshot({ path: file });
      frames.push({ file, t: Date.now() });
    }
  })();
  const caption = (text) =>
    p.evaluate((text) => {
      let el = document.getElementById('demo-caption');
      if (!el) {
        el = document.createElement('div');
        el.id = 'demo-caption';
        el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;max-width:760px;padding:12px 18px;border-radius:14px;background:rgba(20,22,30,.92);color:#fff;font:500 17px/1.35 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.12)';
        document.body.appendChild(el);
      }
      el.style.display = text ? 'block' : 'none';
      el.textContent = text;
    }, text);

  await wait(1500);
  // Into the studio (and past the tour): the AI builds the song in front of you.
  await p.evaluate(() => document.querySelector('.welcome-more .btn.primary').click());
  await wait(300);
  await p.evaluate(() => [...document.querySelectorAll('.tour-card button')].at(-1)?.click());
  await wait(700);
  await caption('💬  “Make a lo-fi beat at 82 BPM in D minor with drums, bass and Rhodes, then loop it”');
  await wait(2200);
  await call('begin_change', { label: 'Lo-fi beat' });
  await call('new_project', { name: 'Lo-fi night', bpm: 82, key: 'Dm' });
  await p.evaluate(() => document.querySelector('.ai-pill')?.click());
  await wait(700);
  const drums = (await call('add_track', { kind: 'drums', instrument: 'kit-lofi', name: 'Drums' })).track_id;
  await wait(400);
  await call('add_drum_pattern', { track_id: drums, start_bar: 1, bars: 4, pattern: { kick: 'x.....x...x.....', snare: '....x.......x...', hihat: 'x.x.x.x.x.x.x.xx' } });
  await wait(700);
  const keys = (await call('add_track', { kind: 'instrument', instrument: 'velvet-keys', name: 'Rhodes' })).track_id;
  await wait(400);
  await call('add_chord_progression', { track_id: keys, chords: ['Dm9', 'Gm7', 'Bbmaj7', 'A7'], start_bar: 1, beats_per_chord: 4, octave: 3, style: 'block', velocity: 0.6 });
  await wait(700);
  const bass = (await call('add_track', { kind: 'instrument', instrument: 'finger-bass', name: 'Bass' })).track_id;
  await wait(400);
  const line = [['D2', 0], ['D2', 1.5], ['A2', 3], ['G2', 4], ['G2', 5.5], ['D2', 7], ['A#1', 8], ['A#1', 9.5], ['F2', 11], ['A1', 12], ['C#2', 14], ['E2', 15]];
  await call('add_region', { track_id: bass, start_bar: 1, length_bars: 4, notes: line.map(([pitch, start]) => ({ pitch, start, duration: 0.9, velocity: 0.8 })) });
  await wait(500);
  await call('update_track', { track_id: keys, reverb: 0.35, tone: 0.6 });
  await call('set_loop', { enabled: true, start_bar: 1, end_bar: 5 });
  await call('end_change');
  await caption('');
  await call('transport', { action: 'play', from_bar: 1 });
  await wait(4000);
  await p.evaluate(() => document.querySelector('.ai-pill')?.click());
  await p.keyboard.press('x');
  await wait(4500);
  await call('transport', { action: 'stop' });
  recording = false;
  await loop;
} finally {
  await b.close();
  await c.close();
}

// Frames → GIF at their real timing (concat demuxer with durations), one palette for the whole clip.
const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.t ?? f.t + 100) - f.t) / 1000).toFixed(3)}`).join('\n');
fs.writeFileSync(path.join(dir, 'list.txt'), `${list}\nfile '${frames.at(-1).file}'\n`);
const vf = 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', vf, '-loop', '0', out], { stdio: 'inherit' });
fs.rmSync(dir, { recursive: true, force: true });
console.log(`${out}: ${frames.length} frames, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
