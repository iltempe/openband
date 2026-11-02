#!/usr/bin/env node
// Bundles that aren't the studio. The pure part of `openband test`, for Node: the package has no TypeScript or esbuild at run time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The cassette's player: one script, carried inside every cassette, under 250 KB gzipped.
await build({ entryPoints: [path.join(root, 'src/cassette-player/player.ts')], bundle: true, minify: true, format: 'iife', target: 'es2020', outfile: path.join(root, 'dist/cassette/player.js'), logLevel: 'error' });
fs.copyFileSync(path.join(root, 'src/cassette-player/style.css'), path.join(root, 'dist/cassette/player.css'));
await build({ entryPoints: [path.join(root, 'src/tests/cli.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(root, 'dist/cli/song-test.mjs'), logLevel: 'error' });
