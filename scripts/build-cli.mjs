#!/usr/bin/env node
// The pure part of `openband test`, bundled for Node: the package has no TypeScript or esbuild at run time.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({ entryPoints: [path.join(root, 'src/tests/cli.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(root, 'dist/cli/song-test.mjs'), logLevel: 'error' });
