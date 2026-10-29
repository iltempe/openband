#!/usr/bin/env node
// OpenBand MCP server.
//
//   AI client (Claude Desktop, Cursor, …) ──stdio/MCP──▶ this process ──WebSocket──▶ OpenBand in the browser
//
// It also serves the production build (dist/) on http://127.0.0.1:7777 so the studio can be
// opened without running Vite. Never write to stdout here: stdout carries the MCP protocol.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EventBuffer } from './events.mjs';
import { CAPABILITY, CORE, INSTRUCTIONS, TOOLS, TOOLSETS } from './tools.mjs';
import { Pairing, classifyOrigin, parseAllowedOrigins } from './pairing.mjs';
import { checkForUpdate } from './update.mjs';
import { RUN } from './package.mjs';
import { PublishHost } from './publish/index.mjs';
import { ProtectHost } from './protect/index.mjs';
import { EngineHost } from './engines.mjs';
import { StreamRelay } from './streams.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

/** Default 7777; if it is taken (and no port was asked for) the next free one is used. */
const PORT = process.env.OPENBAND_PORT && Number(process.env.OPENBAND_PORT) ? Number(process.env.OPENBAND_PORT) : await findFreePort(7777);
/** stdio MCP (default) or just the studio server (`openband start`). */
const STDIO = process.env.OPENBAND_STDIO !== '0';
/**
 * Which tools an MCP client sees first (SPEC v0.6 §8.1): "all" (the default — every client works as
 * before) or "core" (core + capability tools; the rest with load_toolset, announced by
 * tools/list_changed). --toolsets=core on the command line, or OPENBAND_TOOLSETS=core.
 */
const TOOLSET_MODE = (process.argv.find((a) => a.startsWith('--toolsets='))?.split('=')[1] ?? process.env.OPENBAND_TOOLSETS ?? 'all') === 'core' ? 'core' : 'all';
/** Open the studio in the browser by itself: at start (`openband start`) or at the first tool call (`openband mcp`). */
const OPEN_BROWSER = !['0', 'false', 'no'].includes(String(process.env.OPENBAND_OPEN_BROWSER ?? '').toLowerCase());
/** Folder that relative sample paths are resolved against (the .mcpb extension lets the user pick it). */
// An unset extension setting can arrive as the literal placeholder: ignore it.
const SAMPLES_DIR = /\$\{/.test(process.env.OPENBAND_SAMPLES_DIR ?? '') ? '' : process.env.OPENBAND_SAMPLES_DIR || '';
/** OPENBAND_COLLAB=1 opens the server to the local network for multiplayer rooms (the AI bridge stays local-only). */
const COLLAB = process.env.OPENBAND_COLLAB === '1';
/** OPENBAND_REMOTE_MCP=1: an MCP endpoint at /mcp (Streamable HTTP) for claude.ai and other remote clients. */
const REMOTE = process.env.OPENBAND_REMOTE_MCP === '1';
/** Loaded only in remote mode (it brings in the SDK's HTTP transport). */
const remoteMod = REMOTE ? await import('./remote.mjs') : null;
const HOST = process.env.OPENBAND_HOST || (COLLAB || REMOTE ? '0.0.0.0' : '127.0.0.1');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DEV_URL = process.env.OPENBAND_DEV_URL || 'http://localhost:5173';
const log = (...a) => console.error('[openband]', ...a);

async function findFreePort(from) {
  const net = await import('node:net');
  for (let p = from; p < from + 50; p++) {
    const free = await new Promise((resolve) => {
      const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  return from;
}

// ---------------------------------------------------------------- HTTP + WebSocket bridge

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
/** OMEP engines the user configured (SPEC v0.6 §9). Never on a public server: there the page is a stranger's. */
const engineHost = REMOTE ? null : new EngineHost({ log });
/** Real-time streams from engines (stream.jam), relayed to the page on /stream/<id>. */
const streamRelay = engineHost ? new StreamRelay({ engines: engineHost, log }) : null;
/** Publishing (SPEC v0.6 G6): the user's keys stay in this process; never on a public server. */
/** Timestamps (G7): only digests leave; not on a public server either (its calendars would be someone else's choice). */
const protectHost = REMOTE ? null : new ProtectHost();
const publishHost = REMOTE ? null : new PublishHost({ port: PORT, log, notify: (m) => studio?.readyState === 1 && studio.send(JSON.stringify(m)) });
const CONFIG_FILE = process.env.OPENBAND_CONFIG || '';
/** Public instances (Docker) send the same CSP as the static hosts. */
const CSP = process.env.OPENBAND_CSP === '1' ? (await import('./csp.mjs')).contentSecurityPolicy({ collab: process.env.OPENBAND_CSP_COLLAB ? process.env.OPENBAND_CSP_COLLAB.split(',') : undefined }) : '';

const httpServer = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://x').pathname;
  if (remote && (await remote.handleHttp(req, res))) return;
  if (publishHost && (await publishHost.handleHttp(req, res))) return;
  if (pathname === '/version.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ app: 'openband', version: PKG.version }));
    return;
  }
  // Instance settings without rebuilding: OPENBAND_CONFIG points to a config.json (see config.example.json).
  if (pathname === '/config.json' && (CONFIG_FILE || REMOTE)) {
    fs.readFile(CONFIG_FILE || '-', (err, data) => {
      let cfg = {};
      try {
        if (!err) cfg = JSON.parse(String(data));
      } catch {
        // malformed: defaults
      }
      // The studio shows the "Claude (remote)" tab only where /mcp exists.
      if (REMOTE) cfg.remoteMcp = true;
      res.writeHead(err && !REMOTE ? 404 : 200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(cfg));
    });
    return;
  }
  if (CSP) res.setHeader('content-security-policy', CSP);
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`OpenBand bridge is running. Run "npm run build" to serve the studio here, or open ${DEV_URL} (npm run dev).`);
    return;
  }
  const url = new URL(req.url || '/', `http://${HOST}`);
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file);
  const cache = /\/assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache });
  fs.createReadStream(file).pipe(res);
});

/** Bridge protocol version, exchanged in hello (the online demo may be newer than this server). */
const PROTOCOL = 1;
/** Public sites (the online demo) that may drive the studio after pairing with a code. */
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.OPENBAND_ALLOWED_ORIGINS);
const pairing = new Pairing({ code: process.env.OPENBAND_PAIR_CODE || undefined });

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

// One HTTP server, several WebSocket endpoints: route upgrades by path.
const wss = new WebSocketServer({ noServer: true });
// Multiplayer endpoints load Yjs only when asked for.
const collab = COLLAB ? (await import('./collab.mjs')).createCollab() : null;
httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '/', 'http://x');
  if (pathname === '/bridge') {
    // The bridge controls the studio: only over loopback, from pages served by this machine — or from an
    // allowed public site (the online demo), which then has to pair with a code before anything happens.
    let kind = classifyOrigin(req.headers.origin, ALLOWED_ORIGINS);
    // Remote mode: pages served by this very server (same host) may connect from anywhere, but they can
    // only be driven by the MCP session they pair with.
    // (Also behind a reverse proxy on this machine, which forwards the Host header.)
    if (REMOTE && kind !== 'local' && sameHost(req)) kind = 'remote';
    if (kind === 'reject' || (kind !== 'remote' && !isLoopback(req.socket.remoteAddress))) return void socket.destroy();
    return void wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, kind));
  }
  if (collab?.handles(pathname)) return void collab.upgrade(req, socket, head, pathname);
  // A stream id is handed out only over the bridge; the page that got it is on this machine.
  if (streamRelay?.handles(pathname) && isLoopback(req.socket.remoteAddress)) return void streamRelay.upgrade(req, socket, head, pathname);
  socket.destroy();
});

function sameHost(req) {
  try {
    return !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** LAN addresses where other people can open the studio and join rooms. */
function lanUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}

/** What the user does in the studio (phrases, selection, edits…), newest last. */
const events = new EventBuffer(500);

/** @type {import('ws').WebSocket | null} */
let studio = null;
const pending = new Map();
let seq = 0;
let bridgeError = null;
/** Set once the local MCP server exists. */
let notifyProjectResource = () => {};
/** Remote MCP sessions (null unless OPENBAND_REMOTE_MCP=1); its builder is defined further down. */
const remote = remoteMod ? remoteMod.createRemote({ build: (ctx) => buildMcpServer(ctx), log, token: process.env.OPENBAND_REMOTE_TOKEN || undefined }) : null;

wss.on('connection', (ws, _req, kind = 'local') => {
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const hello = () => send({ type: 'hello', protocol: PROTOCOL, version: PKG.version, update: updateInfo, collab: COLLAB ? { lan: lanUrls(), port: PORT } : null, remote: true });
  /** In remote mode a tab asks to be paired with an MCP session: from then on only that session drives it. */
  let link = null;
  const toRemote = () => {
    if (studio === ws) studio = null;
    link = remote.addLink(ws, () => {
      hello();
      send({ type: 'remote_paired' });
    });
  };
  if (kind === 'remote') {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!link && msg.type === 'hello' && msg.remote) return void toRemote();
      link?.handle(msg);
    });
    return;
  }
  const welcome = () => {
    studio = ws; // the most recent tab wins
    log(kind === 'local' ? 'studio connected' : 'studio connected (paired online demo)');
    send({ type: 'hello', protocol: PROTOCOL, version: PKG.version, update: updateInfo, collab: COLLAB ? { lan: lanUrls(), port: PORT } : null, engines: !!engineHost, publish: !!publishHost && kind === 'local', protect: !!protectHost });
  };
  let paired = kind === 'local';
  if (paired) welcome();
  else {
    send({ type: 'pair_required', protocol: PROTOCOL });
    // A page that never pairs doesn't keep a socket open.
    setTimeout(() => !paired && ws.close(4401, 'not paired'), 120000).unref();
  }
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (link) return void link.handle(msg);
    if (remote && paired && msg.type === 'hello' && msg.remote) return void toRemote();
    if (!paired) {
      if (msg.type !== 'hello') return;
      if (pairing.valid(msg.token)) {
        paired = true;
        send({ type: 'paired', token: msg.token });
        return void welcome();
      }
      if (!msg.pair) return void send({ type: 'pair_required', protocol: PROTOCOL });
      const r = pairing.attempt(msg.pair);
      if (!r.ok) {
        log(`pairing refused (${r.reason})`);
        return void send({ type: 'pair_failed', reason: r.reason, retry_in_ms: r.retryInMs, attempts_left: r.attemptsLeft });
      }
      paired = true;
      send({ type: 'paired', token: r.token });
      return void welcome();
    }
    if (msg.type === 'event' && msg.event?.kind) return void events.push(msg.event);
    if (msg.type === 'project_changed') return void notifyProjectResource();
    if (msg.type === 'engine') {
      // The page asks for the engines or calls one (OpenBand as an OMEP client).
      const answer = (ok, payload) => send({ type: 'engine_result', id: msg.id, ok, ...(ok ? { result: payload } : { error: payload }) });
      if (!engineHost) return void answer(false, 'Engines are not available on this server');
      const job =
        msg.op === 'list'
          ? engineHost.list()
          : msg.op === 'call'
            ? engineHost.call(String(msg.engine), String(msg.capability), msg.args ?? {})
            : msg.op === 'stream_open'
              ? streamRelay.open(String(msg.engine), msg.args ?? {})
              : msg.op === 'stream_close'
                ? streamRelay.close(String(msg.relay))
                : // The user's music services and their keys: only a studio served by this machine.
                  ['services', 'set_service', 'remove_service'].includes(msg.op) && kind !== 'local'
                  ? Promise.reject(new Error('Music services are set up in the studio on this computer (the OpenBand app or npx openband)'))
                  : msg.op === 'services'
                    ? engineHost.services()
                    : msg.op === 'set_service'
                      ? engineHost.setService({ provider: String(msg.provider), key: msg.key ? String(msg.key) : undefined, plan: msg.plan === null ? null : msg.plan ? String(msg.plan) : undefined, model: msg.model ? String(msg.model) : undefined })
                      : msg.op === 'remove_service'
                        ? engineHost.removeService(String(msg.id))
                        : Promise.reject(new Error(`Unknown engine op "${msg.op}"`));
      job.then((r) => answer(true, r), (e) => answer(false, e.message));
      return;
    }
    if (msg.type === 'protect') {
      const answer = (ok, payload) => send({ type: 'protect_result', id: msg.id, ok, ...(ok ? { result: payload } : { error: payload }) });
      if (!protectHost) return void answer(false, 'Timestamps need the OpenBand app or npx openband on this computer');
      protectHost.handle(msg).then((r) => answer(true, r), (e) => answer(false, e.message));
      return;
    }
    if (msg.type === 'publish') {
      // Only a studio served by this machine (not a paired public site) may use the user's accounts.
      const answer = (ok, payload) => send({ type: 'publish_result', id: msg.id, ok, ...(ok ? { result: payload } : { error: payload }) });
      if (!publishHost || kind !== 'local') return void answer(false, 'Publishing needs the OpenBand app or npx openband on this computer');
      publishHost.handle(msg, (fraction, note) => send({ type: 'publish_progress', id: msg.id, fraction, note })).then((r) => answer(true, r), (e) => answer(false, e.message));
      return;
    }
    if (msg.type !== 'result') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'Command failed'));
  });
  ws.on('close', () => {
    if (studio === ws) studio = null;
    log('studio disconnected');
  });
});

httpServer.on('error', (err) => {
  bridgeError = err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (another OpenBand MCP server is running?). Set OPENBAND_PORT and open the studio with ?mcp=<port>.` : err.message;
  log(bridgeError);
});
/** Newer OpenBand on npm? (checked at most once a day; OPENBAND_NO_UPDATE_CHECK=1 turns it off) */
let updateInfo = null;
void checkForUpdate({ current: PKG.version }).then((u) => {
  updateInfo = u;
  if (u?.update_available) {
    log(`OpenBand ${u.latest} is available (you have ${u.current}): ${RUN} gets it, or download the new extension`);
    if (studio?.readyState === 1) studio.send(JSON.stringify({ type: 'update', update: u }));
  }
});

httpServer.listen(PORT, HOST, () => {
  log(`bridge on ws://127.0.0.1:${PORT}/bridge`);
  log(`using the online demo (${ALLOWED_ORIGINS.join(', ')})? Pairing code: ${pairing.pretty()} (valid 10 minutes; open_studio gives a fresh one)`);
  if (COLLAB) log(`multiplayer rooms open on the network: ${lanUrls().join(', ') || '(no LAN address)'}`);
});

const studioUrl = () => (fs.existsSync(DIST) ? `http://127.0.0.1:${PORT}` : DEV_URL) + (PORT !== 7777 ? `?mcp=${PORT}` : '');

function waitForStudio(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (studio || Date.now() - t0 > ms ? resolve(!!studio) : setTimeout(tick, 250));
    tick();
  });
}

let lastAutoOpen = 0;
/** Open the studio: in the desktop app when it launched this server (OPENBAND_APP), else in the default browser. */
function openBrowser(url = studioUrl()) {
  if (process.env.OPENBAND_APP) {
    // This process runs as Node inside the app (ELECTRON_RUN_AS_NODE); the app itself must not.
    const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
    // Chromium checks its sandbox before the app's code runs: the switch must be on the command line.
    const extra = process.env.OPENBAND_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
    spawn(process.env.OPENBAND_APP, [`--studio=${url}`, ...extra], { stdio: 'ignore', detached: true, env }).on('error', () => {}).unref();
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function call(method, params = {}, timeoutMs = 20000) {
  if (bridgeError) throw new Error(bridgeError);
  // First tool call and no studio yet: open it (at most once a minute) and wait for it.
  if ((!studio || studio.readyState !== 1) && OPEN_BROWSER && fs.existsSync(DIST) && Date.now() - lastAutoOpen > 60000) {
    lastAutoOpen = Date.now();
    try {
      openBrowser();
      await waitForStudio(20000);
    } catch {
      // fall through to the error below
    }
  }
  if (!studio || studio.readyState !== 1) {
    throw new Error(`The OpenBand studio is not open. Call the open_studio tool, or ask the user to open ${studioUrl()} in a browser.`);
  }
  const id = String(++seq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for the studio to run ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    studio.send(JSON.stringify({ type: 'call', id, method, params }));
  });
}

// ---------------------------------------------------------------- MCP server

// Tool annotations, set in one place for every tool. In MCP, destructiveHint and openWorldHint default to
// true, so they are always given explicitly.
/** Tools that throw away or replace work (undo still works in the studio, but the AI should ask first). */
const DESTRUCTIVE = new Set(['new_project', 'import_project_json', 'delete_track', 'delete_region', 'remove_notes', 'delete_section', 'delete_take', 'delete_annotation', 'clear_automation', 'clear_reference', 'remove_plugin_effect', 'checkout', 'merge', 'import_midi', 'join_room', 'import_dawproject', 'restore_at', 'delete_flub']);
/** Tools that reach the internet: URL imports and the community plugin catalog, multiplayer rooms. */
const OPEN_WORLD = new Set(['import_sample', 'import_soundfont', 'import_midi', 'import_reference', 'import_dawproject', 'list_plugins', 'search_plugins', 'add_plugin', 'add_plugin_instrument', 'add_plugin_effect', 'create_room', 'join_room', 'search_loops', 'add_loop', 'create', 'list_engines']);
function annotationsFor(name, given = {}) {
  const readOnly = !!given.readOnlyHint;
  return { ...given, readOnlyHint: readOnly, ...(readOnly ? {} : { destructiveHint: DESTRUCTIVE.has(name) }), openWorldHint: OPEN_WORLD.has(name) };
}

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e) => ({ ...text(`Error: ${e.message}`), isError: true });

const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

/** Read a local file path (absolute, ~ or relative to the working dir) or download a URL. */
async function readSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_IMPORT_BYTES) throw new Error('File too large (max 200 MB)');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_IMPORT_BYTES) throw new Error('File too large (max 200 MB)');
    const name = decodeURIComponent(new URL(source).pathname.split('/').pop() || 'download');
    return { data, filename: name };
  }
  // Relative paths are looked up in the samples folder chosen in the Claude Desktop extension settings.
  const expanded = source.replace(/^~(?=$|[\/])/, os.homedir());
  const file = SAMPLES_DIR && !path.isAbsolute(expanded) ? path.resolve(SAMPLES_DIR, expanded) : path.resolve(expanded);
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`File not found: ${file}`);
  if (stat.size > MAX_IMPORT_BYTES) throw new Error('File too large (max 200 MB)');
  return { data: await fs.promises.readFile(file), filename: path.basename(file) };
}

const savePath = (save_to, filename) => {
  let file = path.resolve(save_to.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, filename);
  return file;
};

const REMOTE_INSTRUCTIONS = `${INSTRUCTIONS}

This is a REMOTE OpenBand: before any other tool, pair with the user's browser tab. Ask the user to open the studio, choose "Connect AI" → "Claude (remote)" and read you the 6-digit code; then call pair_studio with it. Files are imported only from public http(s) URLs, and exports come back as data (there is no disk to save to).`;

/**
 * One MCP server. Local (stdio): this machine's studio, local files, exports saved to disk.
 * Remote (Streamable HTTP, one per session): the paired tab only, URL imports only, no disk.
 * @param {{ mode: 'local' | 'remote', call: (method: string, params?: object, timeout?: number) => Promise<any>,
 *   events: () => EventBuffer, pair?: (code: string) => object }} ctx
 */
function buildMcpServer(ctx) {
  const remote = ctx.mode === 'remote';
  const { call } = ctx;
  // Tasks (SPEC v0.6 §8.1): long tools can run as MCP tasks for clients that ask; others get the answer
  // synchronously, as before (the SDK polls the task for them).
  const server = new McpServer(
    { name: 'openband', version: PKG.version },
    { instructions: remote ? REMOTE_INSTRUCTIONS : INSTRUCTIONS, capabilities: { tasks: { requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore() },
  );
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, config, cb) => registerTool(name, { ...config, annotations: annotationsFor(name, config.annotations) }, cb);

  // ---- openband://project resource, with change notifications for subscribed clients
  const PROJECT_URI = 'openband://project';
  const subscriptions = new Set();
  server.registerResource(
    'project',
    PROJECT_URI,
    { title: 'Current OpenBand project', description: 'The song open in the studio (same JSON as get_project). Subscribe to be notified after every change.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await call('get_project', {}), null, 2) }] }),
  );
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscriptions.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscriptions.delete(req.params.uri);
    return {};
  });
  server.notifyProject = () => {
    // After every change: the song, and any song context a client is following.
    for (const uri of subscriptions) if (uri === PROJECT_URI || uri.startsWith('openband://context/')) server.server.sendResourceUpdated({ uri }).catch(() => {});
  };

  // ---- openband://context/… : the Song Context Package (§8.3) — read it instead of five analyses
  const contextOf = (args) => async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await call('get_context', args), null, 2) }] });
  server.registerResource('context', 'openband://context/song', { title: 'Song context', description: 'The Song Context Package of the whole song: tempo, key, sections, chords bar by bar, tracks and roles, melody, lyrics.', mimeType: 'application/json' }, contextOf({}));
  server.registerResource(
    'context-section',
    new ResourceTemplate('openband://context/section/{id}', { list: undefined }),
    { title: 'Section context', description: 'The Song Context Package of one section (its id or name).', mimeType: 'application/json' },
    (uri, { id }) => contextOf({ section_id: decodeURIComponent(String(id)) })(uri),
  );
  server.registerResource(
    'context-bars',
    new ResourceTemplate('openband://context/bars/{range}', { list: undefined }),
    { title: 'Bars context', description: 'The Song Context Package of some bars: openband://context/bars/9-16.', mimeType: 'application/json' },
    (uri, { range }) => {
      const [a, b] = String(range).split('-').map(Number);
      if (!(a >= 1) || !(b >= a)) throw new Error('Bars as <from>-<to>, e.g. 9-16');
      return contextOf({ from_bar: a, to_bar: b })(uri);
    },
  );

  // ---- prompts for the typical flows (shown by clients that support MCP prompts)
  const prompt = (name, title, description, argsSchema, textOf) =>
    server.registerPrompt(name, { title, description, argsSchema }, (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: textOf(args ?? {}) } }] }));
  prompt('loop_to_song', 'From the loop to the song', 'Turn the loop in the studio into a whole song with an energy curve.', { minutes: z.string().optional().describe('How long, e.g. 3:30'), shape: z.string().optional().describe('pop, slow_build, edm_drop or ballad') }, (a) =>
    `Turn the loop in OpenBand into a whole song${a.minutes ? ` of about ${a.minutes}` : ''}. Read openband://context/song (or get_context) first. Draw the energy with set_energy_curve (shape ${a.shape || 'pop'}${a.minutes ? `, seconds for ${a.minutes}` : ''}), then arrange_from_energy: it works on a branch and never changes my notes. Then lint_project, and tell me in a few lines what you built — sections, who plays where, the transitions — and how to compare it with the loop.`);
  prompt('prepare_release', 'Prepare the release', 'Mix and master the song for the platforms and make the release zip.', { genre: z.string().optional(), platforms: z.string().optional().describe('e.g. spotify, apple, youtube') }, (a) =>
    `Prepare my song for release. Listen first (analyze_mix). Mix and master it with mix_pilot${a.genre ? ` for ${a.genre}` : ' (ask me the genre if you can\'t tell)'}, check the result with analyze_mix again, then export_for_platforms for ${a.platforms || 'spotify, apple and youtube'} with stems and an instrumental. Tell me the loudness of each master and anything that could not reach its target.`);
  prompt('vocal_session', 'Vocal session', 'Lyrics, melody and recording takes for a vocal part.', { section: z.string().optional() }, (a) =>
    `Let's do a vocal session${a.section ? ` on the ${a.section}` : ''}. Read the song context, help me with the lyrics (set_lyrics, align_lyrics, check_prosody: stressed syllables on strong beats), then set up recording (arm_track, set_punch on the section) so I can sing takes; afterwards help me compare them (start_ab_test) and comp the best parts (comp_takes). Load the lyrics and recording toolsets if they are not loaded.`);

  if (remote) {
    server.registerTool(
      'pair_studio',
      {
        title: 'Pair with the studio',
        description: 'Binds this conversation to the user\'s OpenBand tab. Ask the user for the 6-digit code shown in the studio under "Connect AI" → "Claude (remote)". Required before any other tool.',
        inputSchema: { code: z.string().describe('The 6-digit code shown in the studio') },
      },
      async ({ code }) => {
        try {
          ctx.pair(code);
          return text({ paired: true, project: await call('get_status', {}) });
        } catch (e) {
          return fail(e);
        }
      },
    );
  } else {
    server.registerTool(
      'open_studio',
      {
        title: 'Open the OpenBand studio',
        description: 'Opens the OpenBand studio in the default browser (if it is not already connected) and waits for it to connect.',
        inputSchema: {},
      },
      async () => {
        if (studio) return text({ connected: true, url: studioUrl() });
        const demo = { online_demo: ALLOWED_ORIGINS[0] ? `${ALLOWED_ORIGINS[0]}${ALLOWED_ORIGINS[0].includes('iltempe.github.io') ? '/openband/' : '/'}` : null, pairing_code: pairing.pretty(), port: PORT };
        const url = studioUrl();
        try {
          openBrowser(url);
        } catch (e) {
          return { ...text(`Could not open a browser: ${e.message}. Ask the user to open ${url}`), isError: true };
        }
        const ok = await waitForStudio(15000);
        return text(
          ok
            ? { connected: true, url, note: 'Ask the user to click "Enter the studio" once so the browser allows audio.' }
            : {
                connected: false,
                url,
                ...demo,
                note: `Opened ${url} but the studio has not connected yet. If the user prefers the online demo, tell them to open it, choose "Connect AI" and enter the code ${demo.pairing_code} (port ${PORT}).`,
              },
        );
      },
    );
  }

  // ---- every tool from server/tools.mjs, with the handler its kind needs
  const read = remote ? (source) => remoteMod.fetchPublic(source, MAX_IMPORT_BYTES) : readSource;
  const HANDLERS = {
    call: (t) =>
      t.name === 'get_status'
        ? async (args) => text({ ...(await call(t.name, args ?? {}, t.timeout)), server: { version: PKG.version, protocol: PROTOCOL, update: updateInfo, mode: ctx.mode } })
        : async (args) => text(await call(t.name, args ?? {}, t.timeout)),
    file: (t) => async ({ source, ...args }) => {
      const { data, filename } = await read(source);
      return text(await call(t.name, { ...args, filename, data_base64: data.toString('base64') }, t.timeout));
    },
    export: (t) => async ({ save_to, ...args }) => {
      if (!save_to) return text(await call(t.name, args, t.timeout));
      const { data_base64, filename, bytes, ...rest } = await call(t.name, { ...args, return_data: true }, t.timeout);
      const file = savePath(save_to, filename);
      await fs.promises.writeFile(file, Buffer.from(data_base64, 'base64'));
      return text({ saved: file, bytes, ...rest });
    },
    chord_sheet: (t) => async ({ format, save_to }) => {
      const res = await call(t.name, { format, return_data: !!save_to }, t.timeout);
      if (!save_to) return text(res.text);
      const file = savePath(save_to, res.filename);
      await fs.promises.writeFile(file, res.text);
      return text({ saved: file, format: res.format, text: res.text });
    },
    image: (t) => async (args) => {
      const r = await call(t.name, args ?? {}, t.timeout);
      return { content: [{ type: 'image', data: r.png_base64, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ width: r.width, height: r.height, from_bar: r.from_bar, to_bar: r.to_bar }) }] };
    },
    toolset: () => async ({ name }) => {
      if (TOOLSET_MODE === 'all') return text({ loaded: name, note: 'Every tool is already available.' });
      const names = name === 'all' ? Object.values(TOOLSETS).flatMap((s) => s.tools) : (TOOLSETS[name]?.tools ?? []);
      const added = names.filter((n) => registered.get(n) && !registered.get(n).enabled);
      for (const n of added) registered.get(n).enable();
      return text({ loaded: name, tools: added.length ? added : 'already loaded', note: added.length ? 'They are available now.' : undefined });
    },
    events_list: () => async (args) => text(ctx.events().list(args)),
    events_wait: () => async (args) => text(await ctx.events().wait(args)),
  };
  const sourceArg = () =>
    z.string().describe(remote ? 'Public http(s) URL of the file' : SAMPLES_DIR ? `File path (absolute, ~/..., or relative to ${SAMPLES_DIR}) or http(s) URL` : 'Absolute file path (or ~/...) or http(s) URL');
  /** Remote: no disk on this side, so no save_to. */
  const shapeFor = (t) => {
    if (t.kind === 'file') return { source: sourceArg(), ...t.shape };
    if (remote && (t.kind === 'export' || t.kind === 'chord_sheet')) {
      const { save_to: _drop, ...rest } = t.shape ?? {};
      return rest;
    }
    return t.shape;
  };
  const registered = new Map();
  /** Long generations: an MCP task for clients that ask, the same answer synchronously otherwise. */
  const TASK_TOOLS = new Set(['create', 'transform', 'separate', 'sing', 'arrange_from_energy']);
  const asTask = (t, handler) =>
    server.experimental.tasks.registerToolTask(
      t.name,
      { title: t.title, description: t.description, inputSchema: shapeFor(t), annotations: annotationsFor(t.name, t.annotations), execution: { taskSupport: 'optional' } },
      {
        async createTask(args, { taskStore, taskRequestedTtl }) {
          const task = await taskStore.createTask({ ttl: taskRequestedTtl ?? 15 * 60_000, pollInterval: 100 });
          (async () => {
            let result;
            try {
              result = await handler(args ?? {});
            } catch (e) {
              result = fail(e);
            }
            await taskStore.storeTaskResult(task.taskId, result.isError ? 'failed' : 'completed', result).catch(() => {});
          })();
          return { task };
        },
        getTask: (_args, { taskId, taskStore }) => taskStore.getTask(taskId),
        getTaskResult: (_args, { taskId, taskStore }) => taskStore.getTaskResult(taskId),
      },
    );
  for (const t of TOOLS) {
    const handler = HANDLERS[t.kind](t);
    const rt = TASK_TOOLS.has(t.name)
      ? asTask(t, handler)
      : server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: shapeFor(t), annotations: t.annotations }, async (args) => {
          try {
            return await handler(args ?? {});
          } catch (e) {
            return fail(e);
          }
        });
    registered.set(t.name, rt);
    // Core mode: only core and capability tools to start with (load_toolset brings the others).
    if (TOOLSET_MODE === 'core' && !CORE.includes(t.name) && !CAPABILITY.includes(t.name)) rt.disable();
  }
  return server;
}

const localServer = buildMcpServer({ mode: 'local', call, events: () => events });
notifyProjectResource = () => localServer.notifyProject();

if (STDIO) {
  await localServer.connect(new StdioServerTransport());
  log('MCP server ready');
} else {
  log(`studio on ${studioUrl()}`);
  if (OPEN_BROWSER) openBrowser();
}
