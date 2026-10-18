#!/usr/bin/env node
// openband-lint: check OpenBand songs (.openband.json / .openband) in CI.
//
//   node scripts/openband-lint.mjs songs/*.openband.json [--format=text|json|github] [--fail-on=error|warn|info|none] [--min-severity=info|warn|error]
//
// Exits 1 when an issue at or above --fail-on (default: error) is found.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => (args.find((a) => a.startsWith(`--${name}=`)) ?? `=${def}`).split('=')[1];
const files = args.filter((a) => !a.startsWith('--'));
const format = opt('format', 'text');
const failOn = opt('fail-on', 'error');
const minSeverity = opt('min-severity', 'info');
if (!files.length) {
  console.error('usage: openband-lint <song.openband.json | song.openband> … [--format=text|json|github] [--fail-on=error|warn|info|none]');
  process.exit(2);
}

// Bundle the TypeScript linter (pure modules) for Node, once per run.
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openband-lint-')), 'lint.mjs');
await build({ entryPoints: [path.join(root, 'src/lint/cli.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const { lintFile } = await import(pathToFileURL(out).href);

const rank = { info: 0, warn: 1, error: 2, none: 3 };
let failed = false;
const results = [];
for (const file of files) {
  let res;
  try {
    res = lintFile(new Uint8Array(fs.readFileSync(file)), { minSeverity });
  } catch (e) {
    res = { project: file, issues: [{ id: 'unreadable', rule: 'unreadable', severity: 'error', message: e.message, target: {} }], counts: { error: 1, warn: 0, info: 0 } };
  }
  results.push({ file, ...res });
  if (res.issues.some((i) => rank[i.severity] >= rank[failOn])) failed = true;
}

if (format === 'json') {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    if (format === 'github') {
      for (const i of r.issues) {
        const level = i.severity === 'error' ? 'error' : i.severity === 'warn' ? 'warning' : 'notice';
        const where = i.target.from_beat !== undefined ? ` (bar ${Math.floor(i.target.from_beat / 4) + 1})` : '';
        console.log(`::${level} file=${r.file},title=${i.rule}::${i.message}${where}`);
      }
    } else {
      console.log(`${r.file} — ${r.project}: ${r.counts.error} error(s), ${r.counts.warn} warning(s), ${r.counts.info} note(s)`);
      for (const i of r.issues) console.log(`  ${i.severity.padEnd(5)} ${i.rule.padEnd(22)} ${i.message}${i.fix ? `  [fix: ${i.fix.label}]` : ''}`);
    }
  }
}
process.exit(failed ? 1 : 0);
