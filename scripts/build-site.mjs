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
const IMAGES = ['studio.png', 'pilot.png', 'ensemble-create.png', 'jam-ghosts.png', 'takes.png', 'versions.png', 'multiplayer.png', 'native-plugins.png', 'master-chain.png', 'chat.png', 'ghost-notes-card.png', 'energy-lane-card.png', 'stems-card.png', 'voice-card.png', 'release-card.png', 'ensemble.png', 'og-card.png', 'og-contribute.png', 'og-card-it.png', 'og-contribute-it.png'];
const PAGES = ['index.html', 'contribute.html'];

/**
 * The Italian site, /it/: the same pages with what social networks read (they run no JavaScript) in
 * Italian — title, description, the Open Graph / Twitter tags and the Italian preview image — and
 * data-lang="it", so site.js shows them in Italian. A link shared from the Italian site previews in Italian.
 */
const IT_META = {
  'index.html': {
    title: 'OpenBand — lo studio musicale che costruiamo tutti insieme',
    description: 'OpenBand è uno studio musicale (DAW) gratuito e open source che chiunque può migliorare: proponi una funzione, seguila sulla roadmap pubblica, suonala nella prossima release. Nel browser o su macOS, Windows e Linux, e anche la tua AI può suonarci.',
    ogTitle: 'OpenBand — fai musica, gratis, nel browser',
    ogDescription: 'Un vero studio musicale (DAW), gratuito e open source: nel browser o su macOS, Windows e Linux. Chiunque può migliorarlo, e anche la tua AI può suonarci. Aprilo e inizia un brano in pochi secondi.',
    image: 'og-card-it.png',
    alt: 'OpenBand: «Fai musica. Gratis, per tutti.» — lo studio con batteria, basso, tastiere e un pad sulla timeline',
  },
  'contribute.html': {
    title: 'Contribuisci a OpenBand — proponi una funzione',
    description: 'Proponi una funzione per OpenBand, lo studio musicale open source che chiunque può migliorare. La tua idea diventa un issue pubblico su GitHub, nella roadmap.',
    ogTitle: 'La tua idea, nella prossima release di OpenBand',
    ogDescription: 'Proponi una funzione per OpenBand, lo studio musicale gratuito e open source che chiunque può migliorare. Diventa un issue pubblico nella roadmap: seguila, poi suonala.',
    image: 'og-contribute-it.png',
    alt: 'OpenBand: «La tua idea, nella prossima release.» — proponi una funzione per lo studio musicale gratuito',
  },
};
const esc = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const urlOf = (page, it) => `https://${DOMAIN}/${it ? 'it/' : ''}${page === 'index.html' ? '' : page}`;

/** Both versions name each other (hreflang), for search engines. */
function withAlternates(html, page) {
  const links = `<link rel="alternate" hreflang="en" href="${urlOf(page, false)}" />\n    <link rel="alternate" hreflang="it" href="${urlOf(page, true)}" />\n    <link rel="alternate" hreflang="x-default" href="${urlOf(page, false)}" />`;
  return html.replace(/(<link rel="canonical"[^>]*>)/, `$1\n    ${links}`);
}

export function italianPage(html, page) {
  const m = IT_META[page];
  const meta = (attr, name, value) => {
    const re = new RegExp(`(<meta ${attr}="${name.replace(/:/g, ':')}" content=")[^"]*(")`);
    if (!re.test(html)) throw new Error(`${page}: no <meta ${attr}="${name}"> to translate`);
    html = html.replace(re, `$1${esc(value)}$2`);
  };
  html = html.replace('<html lang="en">', '<html lang="it" data-lang="it">');
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`);
  meta('name', 'description', m.description);
  meta('property', 'og:url', urlOf(page, true));
  meta('property', 'og:title', m.ogTitle);
  meta('property', 'og:description', m.ogDescription);
  meta('property', 'og:image', `https://${DOMAIN}/img/${m.image}`);
  meta('property', 'og:image:alt', m.alt);
  meta('property', 'og:locale', 'it_IT');
  meta('property', 'og:locale:alternate', 'en_US');
  meta('name', 'twitter:title', m.ogTitle);
  meta('name', 'twitter:description', m.ogDescription);
  meta('name', 'twitter:image', `https://${DOMAIN}/img/${m.image}`);
  meta('name', 'twitter:image:alt', m.alt);
  html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${urlOf(page, true)}$2`);
  // One folder down: the shared files are in the parent.
  html = html.replace(/((?:src|href)=")((?:img\/)?[\w.-]+\.(?:png|svg|css|js))"/g, '$1../$2"');
  return withAlternates(html, page);
}

function buildSite(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'site'), out, { recursive: true });
  fs.mkdirSync(path.join(out, 'img'), { recursive: true });
  for (const f of IMAGES) fs.copyFileSync(path.join(root, 'docs', f), path.join(out, 'img', f));
  for (const f of ['icon.svg', 'favicon.svg']) fs.copyFileSync(path.join(root, 'public', f), path.join(out, f));
  fs.mkdirSync(path.join(out, 'it'), { recursive: true });
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(out, page), 'utf8');
    fs.writeFileSync(path.join(out, 'it', page), italianPage(html, page));
    fs.writeFileSync(path.join(out, page), withAlternates(html, page));
  }
  // Every file a page points at must be there.
  for (const page of [...PAGES, ...PAGES.map((p) => `it/${p}`)])
    for (const [, src] of fs.readFileSync(path.join(out, page), 'utf8').matchAll(/(?:src|href)="((?:\.\.\/)?(?:img\/)?[\w.-]+\.(?:png|svg|css|js))"/g))
      if (!fs.existsSync(path.join(out, path.dirname(page), src))) throw new Error(`${page}: missing ${src} (add it to IMAGES in scripts/build-site.mjs)`);
  for (const m of Object.values(IT_META)) if (!fs.existsSync(path.join(out, 'img', m.image))) throw new Error(`missing img/${m.image} (node scripts/build-og.mjs)`);
}

/** Pages that send the old address to the domain, keeping the page and the anchor. */
function buildRedirect(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(out, 'it'), { recursive: true });
  for (const page of [...PAGES, ...PAGES.map((p) => `it/${p}`)]) {
    const to = `https://${DOMAIN}/${page.replace(/(^|\/)index\.html$/, '$1')}`;
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
