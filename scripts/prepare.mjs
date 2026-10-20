#!/usr/bin/env node
// npm runs this on install from git (`npx -y github:iltempe/openband`, for contributors; releases ship openband.tgz already built): build the studio so the package
// has its dist/. Skipped when dist/ is already there (a checkout that was built, the npm tarball) or when
// the build tools are not installed (production installs such as the Docker image).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(root, 'dist', 'index.html'))) process.exit(0);
if (!fs.existsSync(path.join(root, 'node_modules', 'vite'))) {
  console.error('[openband] build tools not installed: skipping the studio build');
  process.exit(0);
}
console.error('[openband] building the studio (first install only)…');
const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
