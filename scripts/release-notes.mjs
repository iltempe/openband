#!/usr/bin/env node
// Print the CHANGELOG section of a version (default: package.json's) — the GitHub Release notes.
//   node scripts/release-notes.mjs [version]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).replace(/^v/, '');
const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const lines = md.split('\n');
// "## v0.3 …" / "## 0.3.0 …" / "## v0.3.0 …" all match 0.3.0; "Unreleased" is used when nothing else does.
const minor = version.split('.').slice(0, 2).join('.');
const heads = lines.map((l, i) => [l, i]).filter(([l]) => /^## /.test(l));
const match = heads.find(([l]) => new RegExp(`^## v?(${version.replace(/\./g, '\\.')}|${minor.replace(/\./g, '\\.')})\\b`).test(l)) ?? heads.find(([l]) => /^## Unreleased/i.test(l));
if (!match) {
  console.error(`No CHANGELOG section for ${version}`);
  process.exit(1);
}
const start = match[1];
const next = heads.find(([, i]) => i > start);
console.log(lines.slice(start + 1, next ? next[1] : undefined).join('\n').trim());
