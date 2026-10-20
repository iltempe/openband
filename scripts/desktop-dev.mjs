#!/usr/bin/env node
// Run the desktop app from the checkout (after `npm run build` and `npm ci --prefix desktop`).
// Its songs are kept in an "OpenBand (dev)" profile, apart from the installed app.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let electron;
try {
  electron = createRequire(path.join(root, 'desktop', 'noop.js'))('electron');
} catch {
  console.error('Electron is not installed: run "npm ci --prefix desktop" first.');
  process.exit(1);
}
// VS Code's terminal (and others) set this: it would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
spawn(electron, [path.join(root, 'desktop', 'main.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env }).on('exit', (code) => process.exit(code ?? 0));
