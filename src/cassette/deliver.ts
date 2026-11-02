// Delivering a cassette (D3): one file, or a folder for any static host. Nothing passes through OpenBand.
import { strToU8, zipSync } from 'fflate';
import { lockKey, toB64u } from './crypto';
import type { StoredCassette } from './burn';

export const FILE_WARN_BYTES = 50 * 1024 * 1024;

const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** No request but its own and the return channels it declares. */
export const playerCsp = (returns: StoredCassette['manifest']['returns'], file: boolean) => {
  const connect = returns.flatMap((r) => (r.kind === 'https' ? [new URL(r.url).origin] : r.signaling));
  return [`default-src 'none'`, `script-src 'unsafe-inline'`, `style-src 'unsafe-inline'`, `img-src blob: data:`, `media-src blob:`, `connect-src ${file ? '' : "'self'"} blob: ${connect.join(' ')}`.trim(), `worker-src 'self'`].join('; ');
};

export function playerHtml(o: { script: string; css: string; title?: string; csp: string; data?: unknown; manifestLink?: boolean }) {
  // The title of the page must not give away the cassette's: it is what a host or an index would see.
  const data = o.data ? `<script>window.__CASSETTE__=${JSON.stringify(o.data).replace(/</g, '\\u003c')}</script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${o.csp}"><title>${o.title ?? 'A cassette'}</title>${o.manifestLink ? '<link rel="manifest" href="app.webmanifest">' : ''}<style>${o.css}</style></head><body>${data}<script>${o.script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}

const SW = `const C='cassette-v1';self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>fetch('files.json').then(r=>r.json()).then(f=>c.addAll(f))))});self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request))));`;

async function assets() {
  const [script, css] = await Promise.all([fetch('./cassette/player.js').then((r) => r.text()), fetch('./cassette/player.css').then((r) => r.text())]);
  return { script, css };
}

/** One .html with everything inside. With a password, the key isn't in any link. */
export async function fileCassette(c: StoredCassette, password?: string) {
  const { script, css } = await assets();
  const data = { manifest: b64(c.pkg.manifest), blobs: Object.fromEntries(Object.entries(c.pkg.blobs).map(([k, v]) => [k, b64(v)])), ...(password ? { lock: await lockKey(c.key, password) } : {}) };
  const html = playerHtml({ script, css, csp: playerCsp(c.manifest.returns, true), data });
  return { html, bytes: html.length, tooBig: html.length > FILE_WARN_BYTES, filename: `${c.title} – ${c.manifest.artist}.cassetta.html` };
}

/** Files for a static host: index.html, sw.js, app.webmanifest, c.bin, b/<id>.bin. */
export async function folderFiles(c: StoredCassette, password?: string) {
  const { script, css } = await assets();
  const blobNames = Object.keys(c.pkg.blobs).map((id) => `b/${id}.bin`);
  const files: Record<string, Uint8Array> = {
    'index.html': strToU8(playerHtml({ script, css, csp: playerCsp(c.manifest.returns, false), manifestLink: true })),
    'sw.js': strToU8(SW),
    'app.webmanifest': strToU8(JSON.stringify({ name: 'Cassette', display: 'standalone', start_url: '.', background_color: '#17140f', theme_color: '#17140f' })),
    'files.json': strToU8(JSON.stringify(['.', 'c.bin', ...blobNames])),
    'c.bin': c.pkg.manifest,
  };
  for (const [id, data] of Object.entries(c.pkg.blobs)) files[`b/${id}.bin`] = data;
  if (password) files['lock.json'] = strToU8(JSON.stringify(await lockKey(c.key, password)));
  return files;
}

export const folderZip = async (c: StoredCassette, password?: string) => zipSync(await folderFiles(c, password), { level: 0 });
export { toB64u };
