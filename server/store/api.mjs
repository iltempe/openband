// HTTP API of the project store (R1.4), under /api/store/v1. Who may call it:
// - this computer, from a page it serves or from no page at all: no code;
// - the LAN or an allowed site: a pairing code once, then a token kept by the browser;
// - the internet: OPENBAND_STORE_TOKEN as well.
// A request only counts as "this computer" when it is loopback AND addressed to a loopback name AND has no
// forwarding headers: a tunnel or reverse proxy connects from 127.0.0.1 on behalf of somebody else.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyOrigin } from '../pairing.mjs';
import { EventBuffer } from '../events.mjs';
import { StoreError } from './fs.mjs';

export const PREFIX = '/api/store/v1';
const MAX_JSON = 256 * 1024 * 1024;
const MAX_SAMPLE = 4 * 1024 * 1024 * 1024;
const FORWARDED = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'tailscale-user-login'];
const LOOPBACK_ADDR = /^(127\.|::1$|::ffff:127\.)/;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const PRIVATE_ADDR = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)|^(::1$|f[cd]|fe80)/i;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function isLocalRequest(req) {
  return LOOPBACK_ADDR.test(req.socket.remoteAddress ?? '') && LOOPBACK_HOST.test(req.headers.host ?? '') && !FORWARDED.some((h) => req.headers[h]) && classifyOrigin(req.headers.origin, []) === 'local';
}

const sameHost = (req) => {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) return reject(new StoreError(413, 'Too big'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new StoreError(413, 'Too big'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req, MAX_JSON)).toString());
  } catch (e) {
    throw e instanceof StoreError ? e : new StoreError(400, 'Bad JSON');
  }
}

export function createStoreApi({ store, pairing, allowedOrigins = [], storeToken = process.env.OPENBAND_STORE_TOKEN || '', log = () => {}, own = process.env.OPENBAND_STORE_AUTO !== '0' }) {
  const events = new EventBuffer(200);
  const sockets = new Set();
  const tokensFile = path.join(store.dir, 'tokens.json');
  // Tokens are kept hashed, so a copy of the library is not a way in. Pairing happens once per browser.
  const tokens = new Set(store.readJson(tokensFile, []));
  const emit = (e) => {
    // The buffer numbers its events in `id`, which on this channel is the project's id.
    const { id: seq, at } = events.push(e);
    const text = JSON.stringify({ ...e, seq, at });
    for (const ws of sockets) if (ws.readyState === 1) ws.send(text);
  };

  const tokenOk = (t) => typeof t === 'string' && t.length > 0 && tokens.has(sha(t));

  /** 'ok' or the reason to refuse. */
  function access(req, token, instanceToken) {
    if (isLocalRequest(req)) return 'ok';
    const kind = classifyOrigin(req.headers.origin, allowedOrigins);
    if (kind === 'reject' && !sameHost(req)) return 'origin';
    const fromLan = PRIVATE_ADDR.test(req.socket.remoteAddress ?? '') && !FORWARDED.some((h) => req.headers[h]);
    if (!fromLan) {
      if (!storeToken) return 'public';
      if (!same(sha(instanceToken ?? ''), sha(storeToken))) return 'instance-token';
    }
    return tokenOk(token) ? 'ok' : 'pair';
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    // The desktop app's page (openband://app) is "local" and still cross-origin to this port.
    if (!origin || classifyOrigin(origin, allowedOrigins) === 'reject') return;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, if-match, x-store-token, x-sample-name, x-openband-client');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
    res.setHeader('access-control-expose-headers', 'etag, content-type, x-sample-name');
  }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const quoted = (etag) => `"${etag}"`;
  const unquoted = (v) => (v === undefined ? undefined : v.replace(/^(W\/)?"|"$/g, ''));
  const wireVersion = (v) => ({ ...v, snapshot: Buffer.from(v.snapshot).toString('base64') });

  async function route(req, res, parts) {
    const m = req.method;
    const by = String(req.headers['x-openband-client'] ?? '').slice(0, 64);
    const [root, id, sub, vid] = parts;
    if (root === 'status' && m === 'GET') return json(res, 200, { ...store.status(), own });
    if (root === 'samples' && id) {
      if (m === 'HEAD' || m === 'GET') {
        const s = store.sampleFile(id);
        if (!s) return json(res, 404, { error: 'No such sample' });
        res.writeHead(200, { 'content-type': s.type, 'content-length': s.bytes, 'x-sample-name': encodeURIComponent(s.name), 'cache-control': 'private, max-age=31536000, immutable' });
        if (m === 'HEAD') return res.end();
        return void fs.createReadStream(s.file).pipe(res);
      }
      if (m === 'PUT') {
        const declared = Number(req.headers['content-length']);
        if (declared) store.ensureRoom(declared);
        const name = decodeURIComponent(String(req.headers['x-sample-name'] ?? id));
        store.putSample(id, await readBody(req, MAX_SAMPLE), name, String(req.headers['content-type'] ?? 'application/octet-stream'));
        return json(res, 201, { id });
      }
    }
    if (root === 'box' && api.box) return boxRoute(req, res, parts.slice(1));
    if (root !== 'projects') return json(res, 404, { error: 'Not found' });
    if (!id) return m === 'GET' ? json(res, 200, store.listProjects()) : json(res, 405, { error: 'Method not allowed' });
    if (!sub) {
      if (m === 'GET') {
        const p = store.getProject(id);
        return p ? json(res, 200, p.value, { etag: quoted(p.etag) }) : json(res, 404, { error: 'No such project' });
      }
      if (m === 'PUT') {
        const { etag } = store.putProject(id, await readJson(req), unquoted(req.headers['if-match']));
        emit({ kind: 'project_changed', id, etag, by });
        return json(res, 200, { etag }, { etag: quoted(etag) });
      }
      if (m === 'DELETE') {
        store.trashProject(id);
        emit({ kind: 'project_changed', id, etag: null, by });
        return json(res, 200, { ok: true });
      }
    }
    if (sub === 'versions') {
      if (m === 'GET' && !vid) return json(res, 200, store.versionMetas(id));
      if (m === 'GET') {
        const v = store.getVersion(id, vid);
        return v ? json(res, 200, wireVersion(v)) : json(res, 404, { error: 'No such version' });
      }
      if (m === 'PUT' && vid) {
        const v = await readJson(req);
        if (v.id !== vid) throw new StoreError(400, 'id must be the one in the path');
        store.putVersion(id, { ...v, snapshot: typeof v.snapshot === 'string' ? new Uint8Array(Buffer.from(v.snapshot, 'base64')) : undefined });
        return json(res, 200, { ok: true });
      }
    }
    if (sub === 'branches') {
      if (m === 'GET') return json(res, 200, store.branches(id));
      if (m === 'PUT') return json(res, 200, store.putBranch(id, await readJson(req)));
    }
    if (sub === 'journal') {
      if (m === 'GET') return json(res, 200, store.journal(id));
      if (m === 'POST') {
        const { entries, remove } = await readJson(req);
        store.appendJournal(id, entries, remove);
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  /** The rehearsal Box, when this server is one: the panel and the buttons. */
  async function boxRoute(req, res, [what, id, sub, ch]) {
    const box = api.box;
    if (req.method === 'GET' && what === 'status') return json(res, 200, box.status());
    if (req.method === 'GET' && what === 'sessions' && !id) return json(res, 200, box.sessions());
    if (req.method === 'GET' && what === 'sessions' && sub === 'channels') {
      const file = box.channelFile(id, ch.replace('.wav', ''));
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-disposition': `attachment; filename="${id}-${ch}"` });
      return void fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'POST') {
      if (what === 'rec') box.recorder.force(!box.recorder.session);
      else if (what === 'mark') return json(res, 200, { at: box.recorder.mark() });
      else if (what === 'arm') box.arm(true);
      else if (what === 'disarm') box.arm(false);
      else if (what === 'sessions' && sub === 'star') box.star(id, (await readJson(req)).starred !== false);
      else return json(res, 404, { error: 'Not found' });
      return json(res, 200, box.status());
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  /** @returns {Promise<boolean>} whether the request was for the store. */
  async function handleHttp(req, res) {
    const pathname = new URL(req.url || '/', 'http://x').pathname;
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
    cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end(), true;
    const parts = pathname.slice(PREFIX.length + 1).split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (parts[0] === 'pair' && req.method === 'POST') {
        const a = access(req, undefined, req.headers['x-store-token']);
        if (a !== 'pair' && a !== 'ok') return json(res, 403, { error: a }), true;
        const result = pairing.attempt((await readJson(req)).code);
        if (!result.ok) return json(res, 403, { error: result.reason, retryInMs: result.retryInMs }), true;
        tokens.add(sha(result.token));
        store.writeJson(tokensFile, [...tokens]);
        return json(res, 200, { token: result.token }), true;
      }
      const a = access(req, String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), req.headers['x-store-token']);
      if (a !== 'ok') return json(res, a === 'pair' ? 401 : 403, { error: a }), true;
      await route(req, res, parts);
    } catch (e) {
      if (e instanceof StoreError) json(res, e.status, { error: e.message, ...(e.etag ? { etag: e.etag } : {}), ...(e.used !== undefined ? { used: e.used, quota: e.quota } : {}) });
      else {
        log(`store: ${e.message}`);
        if (!res.headersSent) json(res, 500, { error: 'Store error' });
      }
    }
    return true;
  }

  /** ws: the page cannot set headers on a WebSocket, so the token travels as a subprotocol, not in the URL. */
  function upgrade(wss, req, socket, head) {
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    const token = protocols.find((p) => p.startsWith('bearer.'))?.slice(7);
    const instance = protocols.find((p) => p.startsWith('instance.'))?.slice(9);
    if (access(req, token, instance) !== 'ok') return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
    });
  }

  const api = { box: null, handleHttp, upgrade, emit, events, store, handles: (pathname) => pathname === `${PREFIX}/events` };
  return api;
}
