// Publishing from the local OpenBand (SPEC v0.6 G6). The page prepares what each platform gets (files and
// metadata) and asks; this process holds the user's keys and tokens and talks to the platforms, so no secret
// is ever in the web app. Files come in over HTTP from the studio this machine serves (a token from the
// bridge, local origins only); the rest goes over the bridge: "publish" messages with an op.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublishStore } from './store.mjs';
import { authorizeUrl, exchangeCode } from './oauth.mjs';
import { archive } from './archive.mjs';
import { commons } from './commons.mjs';
import { soundcloud } from './soundcloud.mjs';
import { youtube } from './youtube.mjs';
import { mixcloud } from './mixcloud.mjs';

export const ADAPTERS = [archive, commons, soundcloud, youtube, mixcloud];
const byId = Object.fromEntries(ADAPTERS.map((a) => [a.id, a]));
const LOCAL_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|openband:\/\/app)$/;
const MAX_ASSET = 4 * 1024 ** 3;

export class PublishHost {
  constructor({ store = new PublishStore(), port, log = () => {}, notify = () => {}, mock = process.env.OPENBAND_PUBLISH_MOCK || '', fetchImpl = fetch, retryDelay } = {}) {
    this.store = store;
    this.port = port;
    this.log = log;
    this.notify = notify;
    this.mock = mock.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.retryDelay = retryDelay;
    this.token = crypto.randomBytes(24).toString('hex');
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-publish-'));
    this.assets = new Map();
    this.pendingAuth = new Map();
  }
  /** Where the platform sends the user back; per platform for those that don't return the state (Mixcloud). */
  redirectUri(a) {
    return `http://127.0.0.1:${this.port}/publish/oauth/callback${a?.redirectPerPlatform ? `/${a.id}` : ''}`;
  }
  endpoints(a) {
    return a.endpoints(this.mock);
  }

  /** What is set up, per platform — never the keys themselves. */
  targets() {
    return ADAPTERS.map((a) => {
      const cfg = this.store.get(a.id);
      return {
        id: a.id,
        name: a.name,
        auth: a.auth,
        configured: a.configured(cfg),
        authorized: a.auth === 'keys' ? a.configured(cfg) : !!cfg.access,
        fields: a.fields.map((f) => ({ ...f, set: !!cfg[f.key === 'access_token' ? 'access' : f.key], ...(f.secret ? {} : { value: cfg[f.key] ?? '' }) })),
        help: a.help,
        ...(a.auth === 'oauth' ? { redirect_uri: this.redirectUri(a) } : {}),
      };
    });
  }

  // ------------------------------------------------------------------ HTTP (from the studio's page)
  async handleHttp(req, res) {
    const url = new URL(req.url || '/', 'http://x');
    if (!url.pathname.startsWith('/publish/')) return false;
    const origin = req.headers.origin;
    const cors = origin && LOCAL_ORIGIN.test(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
    if (url.pathname === '/publish/oauth/callback' || url.pathname.startsWith('/publish/oauth/callback/')) return this.callback(url, res), true;
    if (req.method === 'OPTIONS') {
      res.writeHead(cors['access-control-allow-origin'] ? 204 : 403, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, x-openband-token, x-openband-name', 'access-control-max-age': '600' });
      return res.end(), true;
    }
    const remote = req.socket.remoteAddress;
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!loopback || (origin && !LOCAL_ORIGIN.test(origin)) || req.headers['x-openband-token'] !== this.token) {
      res.writeHead(403, cors).end('forbidden');
      return true;
    }
    if (url.pathname === '/publish/asset' && req.method === 'POST') {
      const id = crypto.randomBytes(12).toString('hex');
      const file = path.join(this.dir, id);
      let size = 0;
      const out = fs.createWriteStream(file);
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_ASSET) req.destroy();
      });
      req.pipe(out);
      out.on('finish', () => {
        const name = decodeURIComponent(String(req.headers['x-openband-name'] ?? id)).replace(/[\\/]/g, '_');
        this.assets.set(id, { path: file, size, name, type: String(req.headers['content-type'] ?? 'application/octet-stream'), at: Date.now() });
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ asset: id, size }));
      });
      out.on('error', () => res.writeHead(500, cors).end());
      return true;
    }
    res.writeHead(404, cors).end();
    return true;
  }

  async callback(url, res) {
    let state = url.searchParams.get('state');
    // A platform that doesn't return the state: the sign-in started last for it, from the callback's path.
    const byPath = url.pathname.split('/')[4];
    if (!state && byPath) state = [...this.pendingAuth].filter(([, v]) => v.platform === byPath).sort((x, y) => y[1].at - x[1].at)[0]?.[0] ?? null;
    const pend = state && this.pendingAuth.get(state);
    const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:40px;background:#111;color:#eee"><h2>${title}</h2><p>${text}</p></body>`;
    if (!pend) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Sign-in not recognised', 'Start it again from OpenBand → Release → Accounts.'));
      return;
    }
    this.pendingAuth.delete(state);
    const err = url.searchParams.get('error');
    try {
      if (err) throw new Error(url.searchParams.get('error_description') || err);
      const a = byId[pend.platform];
      const cfg = this.store.get(a.id);
      const how = { token: this.endpoints(a).token, clientId: cfg.client_id, clientSecret: cfg.client_secret, redirectUri: this.redirectUri(a), code: url.searchParams.get('code'), verifier: pend.verifier };
      const t = a.exchange ? await a.exchange(how, this.fetch) : await exchangeCode(how, this.fetch);
      this.store.set(a.id, { access: t.access, refresh: t.refresh, expires_at: t.expires_at });
      this.notify({ type: 'publish_authorized', platform: a.id, ok: true });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(`Signed in to ${a.name}`, 'You can close this window and go back to OpenBand.'));
    } catch (e) {
      this.notify({ type: 'publish_authorized', platform: pend.platform, ok: false, error: e.message });
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Sign-in failed', String(e.message).replace(/[<>&]/g, '')));
    }
  }

  // ------------------------------------------------------------------ bridge ops
  async handle(msg, progress = () => {}) {
    const a = msg.platform ? byId[msg.platform] : null;
    if (msg.platform && !a) throw new Error(`OpenBand does not publish to "${msg.platform}" yet`);
    switch (msg.op) {
      case 'targets':
        return { token: this.token, targets: this.targets() };
      case 'credentials': {
        const allowed = new Set(a.fields.map((f) => f.key));
        const values = Object.fromEntries(Object.entries(msg.values ?? {}).filter(([k]) => allowed.has(k)).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
        // New client keys invalidate the old sign-in.
        if (a.auth === 'oauth' && 'client_id' in values) Object.assign(values, { access: null, refresh: null, expires_at: null });
        // An owner-only consumer's token is pasted, not signed in for: it is the bearer itself.
        if ('access_token' in values) Object.assign(values, { access: values.access_token, refresh: null, expires_at: null, access_token: null });
        this.store.set(a.id, values);
        return { targets: this.targets() };
      }
      case 'authorize': {
        if (a.auth !== 'oauth') throw new Error(`${a.name} uses keys, not a sign-in`);
        const cfg = this.store.get(a.id);
        if (!a.configured(cfg)) throw new Error(`${a.name}: add your app's client key first`);
        const ep = this.endpoints(a);
        const r = authorizeUrl({ authorize: ep.authorize, clientId: cfg.client_id, redirectUri: this.redirectUri(a), scopes: a.scopes, extra: a.authorizeExtra ?? {} });
        this.pendingAuth.set(r.state, { platform: a.id, verifier: r.verifier, at: Date.now() });
        return { url: r.url };
      }
      case 'forget':
        this.store.forget(a.id);
        return { targets: this.targets() };
      case 'upload': {
        const files = (msg.files ?? []).map((f) => {
          const asset = this.assets.get(f.asset);
          if (!asset) throw new Error('A file to publish is missing: prepare it again');
          return { ...asset, name: f.name ?? asset.name, type: f.type ?? asset.type, ...(f.role ? { role: f.role } : {}) };
        });
        this.log(`publishing to ${a.name}`);
        try {
          return await a.upload({ cfg: this.store.get(a.id), store: this.store, pkg: msg.package ?? {}, files, privacy: msg.privacy, endpoints: this.endpoints(a), onProgress: progress, fetchImpl: this.fetch, ...(this.retryDelay !== undefined ? { retryDelay: this.retryDelay } : {}) });
        } finally {
          for (const f of msg.files ?? []) this.drop(f.asset);
        }
      }
      case 'status':
        return a.status({ id: msg.id, endpoints: this.endpoints(a), fetchImpl: this.fetch });
      default:
        throw new Error(`Unknown publish op "${msg.op}"`);
    }
  }

  drop(id) {
    const a = this.assets.get(id);
    if (!a) return;
    this.assets.delete(id);
    fs.rm(a.path, { force: true }, () => {});
  }
  close() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
