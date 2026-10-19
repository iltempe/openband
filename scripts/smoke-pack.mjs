#!/usr/bin/env node
// Smoke test of the published package: npm pack → install the tarball in an empty folder →
// `openband mcp` answers initialize + tools/list over stdio, and `openband start` serves the studio.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: true }).toString().trim();
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) fail('dist/ is missing: run npm run build first');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-pack-'));
const tgz = sh(`npm pack --silent --pack-destination "${tmp}"`, root).split('\n').pop();
console.log(`✓ packed ${tgz}`);
const app = path.join(tmp, 'app');
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, 'package.json'), '{"name":"smoke","private":true}');
sh(`npm install --silent --no-audit --no-fund "${path.join(tmp, tgz)}"`, app);
const bin = path.join(app, 'node_modules', 'openband', 'bin', 'openband.mjs');
if (!fs.existsSync(bin)) fail('bin/openband.mjs not in the package');
for (const must of ['dist/index.html', 'server/mcp-server.mjs']) if (!fs.existsSync(path.join(app, 'node_modules', 'openband', must))) fail(`${must} not in the package`);
const sizeMb = fs.statSync(path.join(tmp, tgz)).size / 1e6;
console.log(`✓ installed (${sizeMb.toFixed(1)} MB tarball)`);

const version = sh(`node "${bin}" --version`, app);
console.log(`✓ openband --version → ${version}`);

// MCP over stdio, with the SDK client installed as a dependency of the package.
const sdk = path.join(app, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
const { Client } = await import(pathToFileURL(path.join(sdk, 'index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, 'stdio.js')).href);
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], env: { ...process.env, OPENBAND_PORT: '7781', OPENBAND_OPEN_BROWSER: '0' }, stderr: 'ignore' }));
const tools = (await client.listTools()).tools;
if (tools.length < 50) fail(`tools/list returned only ${tools.length} tools`);
console.log(`✓ openband mcp: initialize + tools/list (${tools.length} tools)`);
await client.close();

// openband start serves the studio.
const child = spawn(process.execPath, [bin, 'start'], { env: { ...process.env, OPENBAND_PORT: '7782', OPENBAND_OPEN_BROWSER: '0' }, stdio: 'ignore' });
let ok = false;
for (let i = 0; i < 40 && !ok; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const r = await fetch('http://127.0.0.1:7782/');
    ok = r.status === 200 && (await r.text()).includes('id="root"');
  } catch {
    // not up yet
  }
}
child.kill();
if (!ok) fail('openband start did not serve index.html');
console.log('✓ openband start serves the studio (200)');
fs.rmSync(tmp, { recursive: true, force: true });
