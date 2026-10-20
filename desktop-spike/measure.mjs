#!/usr/bin/env node
// Runs bridge.mjs, opens its page in Chrome, streams audio blocks through the native plugin for
// `seconds`, and reports the round-trip latency distribution and the buffer a glitch-free bridge needs.
//   node measure.mjs <clap-host binary> <plugin.clap> [seconds]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const [hostBin, plugin, secArg] = process.argv.slice(2);
const seconds = Number(secArg ?? 20);
const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = spawn(process.execPath, [path.join(here, 'bridge.mjs'), hostBin, plugin, '7811'], { stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((r) => bridge.stderr.on('data', (d) => String(d).includes('bridge on') && r()));
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:7811/');
  await p.waitForFunction(() => window.ready, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await p.evaluate(() => window.report());
  const r = await p.waitForFunction(() => window.result, { timeout: 5000 }).then((h) => h.jsonValue());
  const ms = r.rtt.map((f) => (f / r.sampleRate) * 1000).sort((a, b) => a - b);
  const q = (x) => ms[Math.min(ms.length - 1, Math.floor(x * ms.length))];
  const quantum = (128 / r.sampleRate) * 1000;
  console.log(JSON.stringify({ blocks: ms.length, quantum_ms: +quantum.toFixed(2), rtt_ms: { p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p99: +q(0.99).toFixed(2), p999: +q(0.999).toFixed(2), max: +ms[ms.length - 1].toFixed(2) }, buffer_for_p999_blocks: Math.ceil(q(0.999) / quantum), context: { baseLatency_ms: +(r.baseLatency * 1000).toFixed(1), outputLatency_ms: +(r.outputLatency * 1000).toFixed(1) } }, null, 1));
} finally {
  await b.close();
  bridge.kill();
}
