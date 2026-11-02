// Cassettes served by the musician's own instance (D3.1): sealed files under /c/<series>/, and an inbox for
// returns. The instance can read neither: it keeps noise for a key it never sees.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StoreError, safeId } from './fs.mjs';

export const MAX_RETURN = 70 * 1024 * 1024; // an overdub of 50 MB, in base64 and JSON
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.bin': 'application/octet-stream' };

/** So many packets per key in a window. Pure, with the clock injected. */
export class RateLimit {
  constructor({ max = 30, windowMs = 60000, now = () => Date.now() } = {}) {
    Object.assign(this, { max, windowMs, now });
    this.hits = new Map();
  }

  take(key) {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) return false;
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
}

export class CassetteHost {
  constructor(dir) {
    this.dir = path.join(dir, 'cassettes');
    this.inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.inboxDir, { recursive: true });
  }

  /** One segment per id, and names only of the shapes a cassette has. */
  file(series, rel) {
    if (!/^(\d+\/)?(index\.html|sw\.js|app\.webmanifest|files\.json|lock\.json|c\.bin|latest\.bin|b\/[\w.-]+\.bin)$/.test(rel)) throw new StoreError(400, 'Bad file');
    return path.join(this.dir, safeId(series), rel);
  }

  put(series, rel, data, store) {
    store.ensureRoom(data.length);
    store.write(this.file(series, rel), data);
  }

  has = (series) => fs.existsSync(path.join(this.dir, safeId(series)));

  retire(series) {
    fs.rmSync(path.join(this.dir, safeId(series)), { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** @returns whether the request was for a cassette. */
  serve(req, res, pathname) {
    const m = /^\/c\/([^/]+)\/(.*)$/.exec(pathname);
    if (!m || !['GET', 'HEAD'].includes(req.method)) return false;
    let file;
    try {
      file = this.file(decodeURIComponent(m[1]), !m[2] || m[2].endsWith('/') ? `${m[2]}index.html` : m[2]);
    } catch {
      return res.writeHead(404).end(), true;
    }
    if (!fs.existsSync(file)) return res.writeHead(404).end(), true;
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file).pipe(res);
    return true;
  }

  accept(series, body, store) {
    if (!this.has(series)) throw new StoreError(404, 'Not found');
    store.ensureRoom(body.length);
    store.write(path.join(this.inboxDir, `${crypto.randomBytes(9).toString('hex')}.json`), body);
  }

  inbox() {
    return fs.readdirSync(this.inboxDir).filter((f) => f.endsWith('.json')).sort();
  }

  read = (id) => fs.readFileSync(path.join(this.inboxDir, `${safeId(id)}`));
  drop = (id) => fs.rmSync(path.join(this.inboxDir, `${safeId(id)}`), { force: true });
}
