#!/usr/bin/env node
// The OpenBand website (site/) into dist/about/, with the screenshots it shows from docs/. Run after
// `npm run build` by pages.yml: the site lives next to the studio at https://iltempe.github.io/openband/about/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'about');
const IMAGES = ['studio.png', 'pilot.png', 'ensemble-create.png', 'jam-ghosts.png', 'takes.png', 'versions.png', 'multiplayer.png', 'native-plugins.png', 'master-chain.png', 'chat.png'];

if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('Build the studio first (npm run build): the site uses its icons.');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'site'), out, { recursive: true });
fs.mkdirSync(path.join(out, 'img'), { recursive: true });
for (const f of IMAGES) fs.copyFileSync(path.join(root, 'docs', f), path.join(out, 'img', f));
// Every image a page points at must be there.
for (const page of fs.readdirSync(out).filter((f) => f.endsWith('.html'))) {
  for (const [, src] of fs.readFileSync(path.join(out, page), 'utf8').matchAll(/src="(img\/[^"]+)"/g))
    if (!fs.existsSync(path.join(out, src))) {
      console.error(`${page}: missing ${src} (add it to IMAGES in scripts/build-site.mjs)`);
      process.exit(1);
    }
}
console.log(`site → ${path.relative(root, out)} (${IMAGES.length} images)`);
