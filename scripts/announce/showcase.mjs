#!/usr/bin/env node
// Motion-graphics videos of several features, for social media:
//   node scripts/announce/showcase.mjs <file.json> [--send]
// file: [{ "theme": "cassette", "title": "…", "points": ["…"], "caption": "…" }]. Without --send it only renders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, sendVideo } from './telegram.mjs';
import { renderVideo } from './video.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const list = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const send = process.argv.includes('--send');
const cfg = send ? readConfig() : null;
if (send && !cfg) throw new Error('Telegram is not set up');
for (const v of list) {
  const out = path.join(root, 'build', 'announce', 'showcase', `openband-${v.theme}-9x16.mp4`);
  if (!send || !fs.existsSync(out)) console.log(`✓ ${v.theme}: ${JSON.stringify(await renderVideo({ ...v, version, out }))}`);
  if (send) {
    await sendVideo(cfg, out, v.caption ?? v.title);
    console.log(`✓ sent ${v.theme}`);
  }
}
