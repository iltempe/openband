// `openband test <song> [--baseline v] [--format text|json|junit] [--strict] [--chrome path]`.
// Tests on notes run here. Tests on audio run in headless Chrome, which opens the studio with ?testrun=<port>:
// the page reads the song from this process, runs the tests and posts the results back. No dependency on
// puppeteer: without Chrome those tests are skipped with a warning, unless --strict.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROMES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
export const findChrome = (given) => (given && fs.existsSync(given) ? given : CHROMES.find((p) => fs.existsSync(p)));

export function parseTestArgs(args) {
  const o = { file: null, format: 'text', strict: false, baseline: null, chrome: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--strict') o.strict = true;
    else if (a.startsWith('--format')) o.format = a.includes('=') ? a.split('=')[1] : args[++i];
    else if (a.startsWith('--baseline')) o.baseline = a.includes('=') ? a.split('=')[1] : args[++i];
    else if (a.startsWith('--chrome')) o.chrome = a.includes('=') ? a.split('=')[1] : args[++i];
    else o.file = a;
  }
  return o;
}

/** Run in the page. Resolves with { results } or rejects. */
async function inChrome({ chrome, bytes, name, baseline, timeoutMs = 600000 }) {
  let done;
  const result = new Promise((resolve, reject) => {
    done = { resolve, reject };
    setTimeout(() => reject(new Error('Audio tests timed out')), timeoutMs).unref();
  });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
  const srv = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.url === '/song') return res.writeHead(200, { ...cors, 'x-name': encodeURIComponent(name), 'access-control-expose-headers': 'x-name', ...(baseline ? { 'x-baseline': baseline } : {}) }).end(bytes);
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.writeHead(200, cors).end();
      done.resolve(JSON.parse(body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const studioPort = 7900 + (process.pid % 90);
  const studio = spawn(process.execPath, [path.join(root, 'bin', 'openband.mjs'), 'start'], { env: { ...process.env, OPENBAND_PORT: String(studioPort), OPENBAND_OPEN_BROWSER: '0', OPENBAND_STORE: '0', OPENBAND_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve, reject) => {
    studio.stderr.on('data', (d) => String(d).includes('bridge on') && resolve());
    studio.on('error', reject);
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-test-'));
  const browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--user-data-dir=${profile}`, `http://127.0.0.1:${studioPort}/?testrun=${port}`], { stdio: 'ignore' });
  try {
    const r = await result;
    if (r.error) throw new Error(r.error);
    return r;
  } finally {
    browser.kill();
    studio.kill();
    srv.close();
    srv.closeAllConnections?.();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function songTest(args) {
  const o = parseTestArgs(args);
  if (!o.file) {
    console.error('usage: openband test <song.openband | song.openband.json> [--baseline <version>] [--format text|json|junit] [--strict] [--chrome <path>]');
    return 2;
  }
  const bundle = path.join(root, 'dist', 'cli', 'song-test.mjs');
  const { symbolicRun, needsAudio, report } = await import(new URL(`file://${bundle}`).href);
  const bytes = fs.readFileSync(o.file);
  const name = path.basename(o.file);
  const { project, run } = symbolicRun(bytes);
  const tests = project.tests ?? [];
  let results = run.results;
  if (needsAudio(tests)) {
    const chrome = findChrome(o.chrome);
    if (chrome) results = (await inChrome({ chrome, bytes, name, baseline: o.baseline })).results;
    else {
      console.error('⚠ No Chrome found: audio tests are skipped. Use --chrome <path>.');
      if (o.strict) return 1;
    }
  }
  console.log(report(name, tests, results, o.format));
  return results.some((r) => !r.pass) ? 1 : 0;
}
