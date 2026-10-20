#!/usr/bin/env node
// What `release.yml` would publish, built and checked without publishing anything:
// the npm tarball and the .mcpb carry the same version, and the CHANGELOG has notes for it.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd) => execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], shell: true }).toString().trim();
const fail = (m) => (console.error(`✗ ${m}`), process.exit(1));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-release-'));
const tgz = sh(`npm pack --silent --pack-destination "${out}"`).split('\n').pop();
if (tgz !== `openband-${version}.tgz`) fail(`tarball ${tgz} ≠ openband-${version}.tgz`);
console.log(`✓ npm tarball ${tgz}`);

sh(`node scripts/build-mcpb.mjs --out="${out}"`);
const mcpb = path.join(out, `openband-${version}.mcpb`);
if (!fs.existsSync(mcpb)) fail(`${path.basename(mcpb)} was not built`);
const manifest = JSON.parse(new TextDecoder().decode(unzipSync(fs.readFileSync(mcpb), { filter: (f) => f.name === 'manifest.json' })['manifest.json']));
if (manifest.version !== version) fail(`.mcpb manifest version ${manifest.version} ≠ ${version}`);
console.log(`✓ Claude Desktop extension ${path.basename(mcpb)} (manifest ${manifest.version})`);

const notes = sh(`node scripts/release-notes.mjs ${version}`);
if (notes.length < 20) fail('no release notes in CHANGELOG.md');
console.log(`✓ release notes (${notes.split('\n').length} lines)`);
const v = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'version.json'), 'utf8'));
if (v.version !== version) fail(`dist/version.json ${v.version} ≠ ${version}`);
console.log(`✓ demo build reports ${v.version}`);
fs.rmSync(out, { recursive: true, force: true });
