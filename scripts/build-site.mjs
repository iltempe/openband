#!/usr/bin/env node
// The OpenBand website (site/), published at https://www.openband.it by its own repository
// (iltempe/openband-site, written by pages.yml), and the old address next to the studio.
//   build/site/   the whole site, self-contained, with CNAME — what goes to iltempe/openband-site
//   dist/about/   the old address (iltempe.github.io/openband/about/): the same site while the domain
//                 isn't live yet, a redirect to www.openband.it once it is (checked at build time).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOMAIN = 'www.openband.it';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'build', 'site');
const about = path.join(root, 'dist', 'about');
const IMAGES = ['studio.png', 'pilot.png', 'ensemble-create.png', 'jam-ghosts.png', 'takes.png', 'versions.png', 'multiplayer.png', 'native-plugins.png', 'master-chain.png', 'chat.png'];
const PAGES = ['index.html', 'contribute.html'];

function buildSite(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'site'), out, { recursive: true });
  fs.mkdirSync(path.join(out, 'img'), { recursive: true });
  for (const f of IMAGES) fs.copyFileSync(path.join(root, 'docs', f), path.join(out, 'img', f));
  for (const f of ['icon.svg', 'favicon.svg']) fs.copyFileSync(path.join(root, 'public', f), path.join(out, f));
  // Every file a page points at must be there.
  for (const page of PAGES)
    for (const [, src] of fs.readFileSync(path.join(out, page), 'utf8').matchAll(/(?:src|href)="((?:img\/)?[\w.-]+\.(?:png|svg|css|js))"/g))
      if (!fs.existsSync(path.join(out, src))) throw new Error(`${page}: missing ${src} (add it to IMAGES in scripts/build-site.mjs)`);
}

/** Pages that send the old address to the domain, keeping the page and the anchor. */
function buildRedirect(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const page of PAGES) {
    const to = `https://${DOMAIN}/${page === 'index.html' ? '' : page}`;
    fs.writeFileSync(
      path.join(out, page),
      `<!doctype html><html><head><meta charset="utf-8"><title>OpenBand</title><link rel="canonical" href="${to}"><meta http-equiv="refresh" content="0; url=${to}"><script>location.replace(${JSON.stringify(to)} + location.hash)</script></head><body><a href="${to}">${to}</a></body></html>\n`,
    );
  }
}

async function domainLive() {
  try {
    const r = await fetch(`https://${DOMAIN}/`, { signal: AbortSignal.timeout(8000) });
    return r.ok && (await r.text()).includes('the music studio everyone builds together');
  } catch {
    return false;
  }
}

buildSite(site);
fs.writeFileSync(path.join(site, 'CNAME'), `${DOMAIN}\n`);
fs.writeFileSync(path.join(site, '.nojekyll'), '');
console.log(`site → ${path.relative(root, site)} (${IMAGES.length} images, CNAME ${DOMAIN})`);
if (fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  if (await domainLive()) {
    buildRedirect(about);
    console.log(`dist/about → redirect to https://${DOMAIN}/`);
  } else {
    buildSite(about);
    console.log(`dist/about → the whole site (https://${DOMAIN}/ is not live yet)`);
  }
}
