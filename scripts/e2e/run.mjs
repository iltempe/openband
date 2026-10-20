#!/usr/bin/env node
// End-to-end checks in a real Chrome, against the built studio served by `openband start`:
//   first-run  — from a fresh profile, "Surprise me" is playing in under 3 s; the tour ignores wrong actions
//   pwa        — installable (no installability errors), and offline after the first visit the app opens and plays
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

function server() {
  const p = spawn(process.execPath, [path.join(root, 'bin', 'openband.mjs'), 'start'], { env: { ...process.env, OPENBAND_PORT: String(PORT), OPENBAND_OPEN_BROWSER: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
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

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(tests);
for (const name of wanted) {
  console.log(`— ${name}`);
  await tests[name]();
}
process.exit(failed ? 1 : 0);
