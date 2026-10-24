#!/usr/bin/env node
// Test the packaged desktop app (build/desktop/*-unpacked or *.app, from scripts/build-desktop.mjs):
//   1. it starts, the studio loads from openband://app and "Surprise me" plays (--smoke);
//   2. its executable in Node mode runs the bundled MCP server (what AI clients launch);
//   3. that server opens the app by itself at the first tool call and drives it (window hidden).
//   node scripts/smoke-desktop.mjs   (Linux CI: under xvfb-run)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'desktop');
const candidates = {
  darwin: ['mac-arm64/OpenBand.app', 'mac/OpenBand.app', 'mac-universal/OpenBand.app'].map((d) => [path.join(out, d, 'Contents', 'MacOS', 'OpenBand'), path.join(out, d, 'Contents', 'Resources', 'app')]),
  win32: [['win-unpacked', 'OpenBand.exe'], ['win-arm64-unpacked', 'OpenBand.exe']].map(([d, e]) => [path.join(out, d, e), path.join(out, d, 'resources', 'app')]),
  linux: ['linux-unpacked', 'linux-arm64-unpacked'].map((d) => [path.join(out, d, 'openband'), path.join(out, d, 'resources', 'app')]),
}[process.platform];
// The one for this machine's architecture first.
const found = candidates.filter(([exe]) => fs.existsSync(exe)).sort(([a]) => (/arm64/.test(a) === (process.arch === 'arm64') ? -1 : 1));
if (!found.length) {
  console.error('No packaged app in build/desktop: run "node scripts/build-desktop.mjs --dir" first.');
  process.exit(2);
}
const [exe, app] = found[0];
let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
};
// The app must not inherit Node mode from the shell (VS Code's terminal sets it).
const { ELECTRON_RUN_AS_NODE: _n, ...baseEnv } = process.env;
const env = { ...baseEnv, OPENBAND_NO_UPDATE_CHECK: '1', ...(process.platform === 'linux' ? { OPENBAND_NO_SANDBOX: '1' } : {}) };

const smoke = spawnSync(exe, ['--smoke', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, encoding: 'utf8', timeout: 90000 });
const line = `${smoke.stdout}${smoke.stderr}`.split('\n').find((l) => l.startsWith('SMOKE')) ?? `exit ${smoke.status} ${smoke.error?.message ?? ''}`;
check(smoke.status === 0 && line.startsWith('SMOKE OK'), `the app starts and plays (${line.trim()})`);
if (smoke.status !== 0) console.log(`${smoke.stderr}`.split('\n').slice(-15).join('\n'));

// Native plugins (G8.2): the CLAP fixtures (built by scripts/build-plughost.mjs, never shipped) on a track.
const fixtures = path.join(root, 'build', 'plughost');
if (fs.existsSync(path.join(fixtures, 'ob-fixtures.clap'))) {
  const n = spawnSync(exe, ['--smoke', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env: { ...env, OPENBAND_SMOKE_NATIVE: '1', OPENBAND_PLUGIN_DIRS: fixtures }, encoding: "utf8", timeout: 180000 });
  const res = `${n.stdout}${n.stderr}`.split('\n').find((l) => l.startsWith('SMOKE-NATIVE')) ?? `exit ${n.status}`;
  check(n.status === 0, `CLAP in the app: effect, crash isolation, instrument, automation, state, identical exports, render cache (${res.trim()})`);
  if (n.status !== 0) console.log(`${n.stderr}`.split('\n').slice(-15).join('\n'));
} else console.log('- native plugins: no fixtures (node scripts/build-plughost.mjs)');

const c = new Client({ name: 'desktop-smoke', version: '1' });
// A throwaway profile: the test's songs must not end up in the user's app.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-smoke-'));
const mcpEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', OPENBAND_APP: exe, OPENBAND_DESKTOP_HIDDEN: '1', OPENBAND_DESKTOP_PROFILE: profile, OPENBAND_PORT: '7792' };
await c.connect(new StdioClientTransport({ command: exe, args: [path.join(app, 'server', 'mcp-server.mjs')], env: mcpEnv, stderr: 'ignore' }));
const { tools } = await c.listTools();
check(tools.length > 100, `the bundled MCP server runs in the app's own Node (${tools.length} tools)`);
const status = await c.callTool({ name: 'get_status', arguments: {} });
check(!status.isError, `the first tool call opens the app and it answers${status.isError ? `: ${status.content[0].text}` : ''}`);
const tempo = await c.callTool({ name: 'set_tempo', arguments: { bpm: 97 } });
check(!tempo.isError && JSON.parse(tempo.content[0].text).bpm === 97, 'set_tempo reaches the studio in the app');
await c.close();
// The app opened by the server keeps running: close it.
if (process.platform === 'win32') spawnSync('taskkill', ['/IM', 'OpenBand.exe', '/F'], { stdio: 'ignore' });
else spawnSync('pkill', ['-f', exe], { stdio: 'ignore' });
process.exit(failed ? 1 : 0);
