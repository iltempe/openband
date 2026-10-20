// Remote MCP (OPENBAND_REMOTE_MCP=1): OpenBand as a connector for claude.ai web/mobile or any MCP client
// over Streamable HTTP. The server is only a relay: each MCP session is bound to ONE browser tab, by a
// 6-digit code that the tab shows and the user tells the AI (pair_studio), or puts in the connector URL
// (?pair=…). Without pairing no tool works. Nothing about the songs is stored here.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { EventBuffer } from './events.mjs';

const CODE_TTL = 10 * 60 * 1000;

/** One studio tab on the other end of a WebSocket: its calls, its results, its events. */
export class StudioLink {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.seq = 0;
    this.events = new EventBuffer(500);
    this.onProjectChanged = null;
  }
  get open() {
    return this.ws.readyState === 1;
  }
  call(method, params = {}, timeoutMs = 20000) {
    if (!this.open) return Promise.reject(new Error('The studio tab is closed: ask the user to reopen it and pair again'));
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for the studio to run ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'call', id, method, params }));
    });
  }
  /** A message from the tab. Results only resolve this link's own calls. */
  handle(msg) {
    if (msg.type === 'event' && msg.event?.kind) return void this.events.push(msg.event);
    if (msg.type === 'project_changed') return void this.onProjectChanged?.();
    if (msg.type !== 'result') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'Command failed'));
  }
  close() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('The studio tab disconnected'));
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------- URL imports without SSRF

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4num = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.some(([base, bits]) => (v4num(ip) & (~0 << (32 - bits))) >>> 0 === (v4num(base) & (~0 << (32 - bits))) >>> 0);
  const a = ip.toLowerCase();
  if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7));
  return a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80') || a.startsWith('ff');
}

/**
 * Download a public http(s) URL for the remote mode: never a local path, never an address of this
 * server's own network (no requests to the LAN, cloud metadata or localhost on the AI's behalf).
 */
export async function fetchPublic(source, maxBytes = 200 * 1024 * 1024, lookup = dns.lookup) {
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error('On a remote OpenBand, files can only be imported from an http(s) URL');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('On a remote OpenBand, files can only be imported from an http(s) URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('That address is not reachable from a remote OpenBand (private or local network)');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error('File too large');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new Error('File too large');
  return { data, filename: decodeURIComponent(url.pathname.split('/').pop() || 'download') };
}

// ---------------------------------------------------------------- sessions and pairing

/**
 * @param {{ build: (ctx: object) => import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, log: (...a: unknown[]) => void, token?: string,
 *   idleMs?: number, callLimit?: number, callWindowMs?: number }} o
 */
export function createRemote(o) {
  const idleMs = o.idleMs ?? 30 * 60 * 1000;
  const callLimit = o.callLimit ?? 60;
  const callWindowMs = o.callWindowMs ?? 10000;
  /** code → link waiting to be paired */
  const waiting = new Map();
  /** session id → { transport, server, link, last, calls, pairFails } */
  const sessions = new Map();

  function newCode() {
    let c;
    do c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    while (waiting.has(c));
    return c;
  }

  /** A tab asked to be reachable remotely: give it a code (renewed while it waits). */
  function addLink(ws, welcome) {
    const link = new StudioLink(ws);
    link.welcome = welcome;
    const issue = () => {
      if (link.session || !link.open) return;
      if (link.code) waiting.delete(link.code);
      link.code = newCode();
      link.codeExpires = Date.now() + CODE_TTL;
      waiting.set(link.code, link);
      ws.send(JSON.stringify({ type: 'remote_code', code: link.code, expires_in_ms: CODE_TTL }));
    };
    issue();
    link.renew = setInterval(issue, CODE_TTL);
    link.renew.unref?.();
    ws.on('close', () => {
      clearInterval(link.renew);
      if (link.code) waiting.delete(link.code);
      link.close();
      if (link.session) link.session.link = null;
    });
    return link;
  }

  /** Wrong codes from every session together: guessing with many sessions is capped too. */
  let allFails = [];
  function pair(session, code) {
    const now = Date.now();
    session.pairFails = session.pairFails.filter((t) => now - t < 60000);
    allFails = allFails.filter((t) => now - t < 60000);
    if (session.pairFails.length >= 5 || allFails.length >= 30) throw new Error('Too many wrong codes: wait a minute and ask the user for the code again');
    const link = waiting.get(String(code ?? '').replace(/\D/g, ''));
    if (!link || link.codeExpires < now) {
      session.pairFails.push(now);
      allFails.push(now);
      throw new Error('No studio is waiting with that code (it may have expired): ask the user to read it again from "Connect to Claude (remote)"');
    }
    waiting.delete(link.code);
    link.code = null;
    clearInterval(link.renew);
    if (session.link && session.link !== link) session.link.session = null;
    session.link = link;
    link.session = session;
    link.onProjectChanged = () => session.server.notifyProject?.();
    link.welcome();
    o.log(`remote MCP session ${session.id.slice(0, 8)} paired with a studio`);
    return { paired: true };
  }

  const ctxFor = (session) => ({
    mode: 'remote',
    pair: (code) => pair(session, code),
    events: () => session.link?.events ?? new EventBuffer(1),
    call: (method, params, timeout) => {
      if (!session.link) throw new Error('Not paired with a studio yet. Ask the user to open the studio, choose "Connect to Claude (remote)" and tell you the 6-digit code, then call pair_studio with it.');
      const now = Date.now();
      session.calls = session.calls.filter((t) => now - t < callWindowMs);
      if (session.calls.length >= callLimit) throw new Error(`Slow down: at most ${callLimit} tool calls every ${callWindowMs / 1000} s`);
      session.calls.push(now);
      return session.link.call(method, params, timeout);
    },
  });

  const authorized = (req, url) => {
    if (!o.token) return true;
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const given = url.searchParams.get('token') ?? bearer;
    return given.length === o.token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(o.token));
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) reject(new Error('body too large'));
        else chunks.push(c);
      });
      req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined));
      req.on('error', reject);
    });

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  /** Handle /mcp; returns false for other paths. */
  async function handleHttp(req, res) {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/mcp') return false;
    if (!authorized(req, url)) return void json(res, 401, { error: 'unauthorized: add ?token=… to the connector URL' }), true;
    try {
      const sid = req.headers['mcp-session-id'];
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      let s = sid ? sessions.get(String(sid)) : undefined;
      if (!s) {
        if (sid || req.method !== 'POST' || !isInitializeRequest(body)) return void json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'No valid session: initialize first' }, id: null }), true;
        s = { id: '', link: null, last: Date.now(), calls: [], pairFails: [] };
        const session = s;
        session.server = o.build(ctxFor(session));
        session.transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            session.id = id;
            sessions.set(id, session);
          },
        });
        session.transport.onclose = () => {
          sessions.delete(session.id);
          if (session.link) session.link.session = null;
        };
        await session.server.connect(session.transport);
        // The code can also come with the connector URL.
        const code = url.searchParams.get('pair');
        if (code) {
          try {
            pair(session, code);
          } catch {
            // the AI can still pair with pair_studio
          }
        }
      }
      s.last = Date.now();
      await s.transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: e.message });
    }
    return true;
  }

  // Idle sessions end (the tab stays open; the AI can reconnect and pair again).
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) if (now - s.last > idleMs) void s.transport.close();
  }, Math.min(60000, idleMs));
  sweep.unref?.();

  return { handleHttp, addLink, sessions, waiting };
}
