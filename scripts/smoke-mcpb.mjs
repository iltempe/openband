#!/usr/bin/env node
// Test the Claude Desktop extension like Claude Desktop runs it: unzip the .mcpb, start the server from
// manifest.json's mcp_config (with ${__dirname} and ${user_config.*} filled in), check tools/list and
// that every tool declares its annotations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const file = process.argv[2] ?? path.join(root, 'build', `openband-${pkg.version}.mcpb`);
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-mcpb-test-'));
for (const [name, data] of Object.entries(unzipSync(fs.readFileSync(file)))) {
  if (name.endsWith('/')) continue;
  const out = path.join(dir, name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
}
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} ≠ package ${pkg.version}`);
for (const f of ['dist/index.html', 'icon.png', manifest.server.entry_point, 'node_modules/@modelcontextprotocol/sdk/package.json']) if (!fs.existsSync(path.join(dir, f))) fail(`${f} missing from the bundle`);
console.log(`✓ unpacked ${path.basename(file)}: ${manifest.tools.length} tools in the manifest`);

const userConfig = { port: 7784, open_browser: false, samples_folder: os.tmpdir() };
const fill = (s) => s.replaceAll('${__dirname}', dir).replace(/\$\{user_config\.(\w+)\}/g, (_, k) => String(userConfig[k] ?? ''));
const cfg = manifest.server.mcp_config;
const client = new Client({ name: 'mcpb-test', version: '1' });
await client.connect(new StdioClientTransport({ command: cfg.command === 'node' ? process.execPath : cfg.command, args: cfg.args.map(fill), env: { ...process.env, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, fill(v)])) }, stderr: 'ignore' }));
const tools = (await client.listTools()).tools;
await client.close();
const names = new Set(tools.map((t) => t.name));
const missing = manifest.tools.filter((t) => !names.has(t.name)).map((t) => t.name);
if (missing.length || names.size !== manifest.tools.length) fail(`manifest and server disagree: ${missing.join(', ') || `${names.size} vs ${manifest.tools.length}`}`);
const bad = tools.filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean' || typeof t.annotations?.openWorldHint !== 'boolean' || (!t.annotations.readOnlyHint && typeof t.annotations.destructiveHint !== 'boolean'));
if (bad.length) fail(`tools without full annotations: ${bad.map((t) => t.name).join(', ')}`);
const expect = { delete_track: 'destructiveHint', new_project: 'destructiveHint', import_sample: 'openWorldHint', search_plugins: 'openWorldHint', get_project: 'readOnlyHint' };
for (const [name, hint] of Object.entries(expect)) if (!tools.find((t) => t.name === name)?.annotations[hint]) fail(`${name} should have ${hint}`);
console.log(`✓ server from the bundle answers tools/list (${tools.length} tools, all annotated)`);
fs.rmSync(dir, { recursive: true, force: true });
