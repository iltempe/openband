#!/usr/bin/env node
// Build the Claude Desktop extension: openband-<version>.mcpb (an MCP Bundle).
//
//   node scripts/build-mcpb.mjs [--out=dir]
//
// The bundle holds the server, the built studio (dist/) and the production node_modules. Its tool list
// is read from the server itself (tools/list), so manifest and server can't drift apart.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? path.join(root, 'build'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: true }).toString();

if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('dist/ is missing: run "npm run build" first.');
  process.exit(1);
}

// 1. Staging folder with what the bundle runs.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-mcpb-'));
const copy = (from, to = from) => fs.cpSync(path.join(root, from), path.join(stage, to), { recursive: true });
copy('dist');
copy('bin');
fs.mkdirSync(path.join(stage, 'server'));
for (const f of fs.readdirSync(path.join(root, 'server'))) if (f.endsWith('.mjs')) copy(`server/${f}`);
copy('mcpb/icon.png', 'icon.png');
copy('LICENSE');
const runtime = { name: pkg.name, version: pkg.version, type: 'module', private: true, dependencies: pkg.dependencies };
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(runtime, null, 2));
sh('npm install --omit=dev --no-audit --no-fund --no-package-lock --silent', stage);

// 2. The tool list, straight from the server.
const client = new Client({ name: 'mcpb-build', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(stage, 'server', 'mcp-server.mjs')], env: { ...process.env, OPENBAND_PORT: '7783', OPENBAND_OPEN_BROWSER: '0' }, stderr: 'ignore' }));
const tools = (await client.listTools()).tools;
await client.close();
const firstSentence = (s = '') => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim().slice(0, 300);

// 3. Manifest (MCP Bundle manifest v0.3).
const manifest = {
  manifest_version: '0.3',
  name: 'openband',
  display_name: 'OpenBand',
  version: pkg.version,
  description: 'A music studio in your browser that Claude can play: compose, arrange, mix and listen to songs.',
  long_description:
    'OpenBand is an open-source, GarageBand-style studio that runs in the browser. With this extension Claude can write parts, arrange sections, mix, analyse the mix like an engineer (loudness, masking, spectrogram), set lyrics to melodies, record from your microphone, keep versions and more. The studio opens in your browser the first time Claude uses it; everything stays on your computer.',
  author: { name: 'OpenBand contributors', url: 'https://github.com/iltempe/openband' },
  repository: { type: 'git', url: 'https://github.com/iltempe/openband' },
  homepage: 'https://iltempe.github.io/openband/',
  documentation: 'https://github.com/iltempe/openband#readme',
  support: 'https://github.com/iltempe/openband/issues',
  icon: 'icon.png',
  license: 'MIT',
  keywords: ['music', 'daw', 'audio', 'midi', 'songwriting', 'mixing'],
  server: {
    type: 'node',
    entry_point: 'server/mcp-server.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/mcp-server.mjs'],
      env: {
        OPENBAND_PORT: '${user_config.port}',
        OPENBAND_OPEN_BROWSER: '${user_config.open_browser}',
        OPENBAND_SAMPLES_DIR: '${user_config.samples_folder}',
      },
    },
  },
  tools: tools.map((t) => ({ name: t.name, description: firstSentence(t.description) })),
  compatibility: { platforms: ['darwin', 'win32'], runtimes: { node: '>=18.0.0' } },
  user_config: {
    port: { type: 'number', title: 'Port', description: 'Port of the local studio (http://127.0.0.1:<port>).', default: 7777, min: 1024, max: 65535 },
    open_browser: { type: 'boolean', title: 'Open the studio automatically', description: 'Open the studio in your browser the first time Claude uses it.', default: true },
    samples_folder: { type: 'directory', title: 'Samples folder', description: 'Optional: a folder Claude can import sounds from by file name.', required: false },
  },
};
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 4. Validate and pack with the official tool.
fs.mkdirSync(outDir, { recursive: true });
const mcpb = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb');
sh(`"${mcpb}" validate "${path.join(stage, 'manifest.json')}"`);
const out = path.join(outDir, `openband-${pkg.version}.mcpb`);
fs.rmSync(out, { force: true });
sh(`"${mcpb}" pack "${stage}" "${out}"`);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`✓ ${path.relative(root, out)} (${tools.length} tools, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
