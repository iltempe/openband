#!/usr/bin/env node
// OpenBand MCP server.
//
//   AI client (Claude Desktop, Cursor, …) ──stdio/MCP──▶ this process ──WebSocket──▶ OpenBand in the browser
//
// It also serves the production build (dist/) on http://127.0.0.1:7777 so the studio can be
// opened without running Vite. Never write to stdout here: stdout carries the MCP protocol.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EventBuffer } from './events.mjs';
import { Pairing, classifyOrigin, parseAllowedOrigins } from './pairing.mjs';
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
/** Open the studio in the browser by itself: at start (`openband start`) or at the first tool call (`openband mcp`). */
const OPEN_BROWSER = !['0', 'false', 'no'].includes(String(process.env.OPENBAND_OPEN_BROWSER ?? '').toLowerCase());
/** Folder that relative sample paths are resolved against (the .mcpb extension lets the user pick it). */
// An unset extension setting can arrive as the literal placeholder: ignore it.
const SAMPLES_DIR = /\$\{/.test(process.env.OPENBAND_SAMPLES_DIR ?? '') ? '' : process.env.OPENBAND_SAMPLES_DIR || '';
/** OPENBAND_COLLAB=1 opens the server to the local network for multiplayer rooms (the AI bridge stays local-only). */
const COLLAB = process.env.OPENBAND_COLLAB === '1';
const HOST = process.env.OPENBAND_HOST || (COLLAB ? '0.0.0.0' : '127.0.0.1');
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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav' };

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const httpServer = http.createServer((req, res) => {
  if (new URL(req.url || '/', 'http://x').pathname === '/version.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ app: 'openband', version: PKG.version }));
    return;
  }
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
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
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
    const kind = classifyOrigin(req.headers.origin, ALLOWED_ORIGINS);
    if (kind === 'reject' || !isLoopback(req.socket.remoteAddress)) return void socket.destroy();
    return void wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, kind));
  }
  if (collab?.handles(pathname)) return void collab.upgrade(req, socket, head, pathname);
  socket.destroy();
});

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

wss.on('connection', (ws, _req, kind = 'local') => {
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const welcome = () => {
    studio = ws; // the most recent tab wins
    log(kind === 'local' ? 'studio connected' : 'studio connected (paired online demo)');
    send({ type: 'hello', protocol: PROTOCOL, version: PKG.version, collab: COLLAB ? { lan: lanUrls(), port: PORT } : null });
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
/** Open the studio in the default browser. */
function openBrowser(url = studioUrl()) {
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

const INSTRUCTIONS = `OpenBand is a GarageBand-style music studio running in the user's browser. You control it with these tools.

Wrap every user request in begin_change("short label") … end_change() so the user can undo it in one step. (Commands sent without it are grouped automatically until you pause for 4 seconds.)
When the user talks about parts of a song (verse, chorus…), call get_structure first and operate on sections (move_section, duplicate_section). Use the energy profile to make a section 'bigger' (more tracks, higher register, more notes, higher velocity) or 'smaller'. If there are no sections yet, auto_sections proposes them.
For vocal lines, keep lyrics and melody aligned: set_lyrics → align_lyrics → check_prosody. Put stressed syllables on strong beats (suggest_melody_rhythm helps).
When get_status reports teach_mode: true, explain your non-obvious musical choices (harmony, voicing, rhythm, mix) with annotate on the exact notes/region/section, using analyze_harmony to be precise. An ask event with context.explain is a request to explain that part: answer with annotate.
In a multiplayer room (get_peers), say who you are acting for and avoid editing a track someone else has selected unless asked.
To jam with the user: set_jam_mode({enabled:true, response_track_id}), then repeatedly wait_for_event({kinds:["phrase"]}) and answer with play_phrase (it is quantized to the next window, so latency is fine).
Before a big rework, save_version; to try a different direction without losing the current one, create_branch + checkout (merge brings the good parts back).
To offer alternatives, add them as takes (add_take) and let the user pick with a blind test (start_ab_test, then wait_for_event ab_result).
Run lint_project before declaring a task done and fix errors (apply_fix).
Before mixing decisions, LISTEN: call analyze_mix (and render_spectrogram if useful). After changes, analyze again and compare. If the user names a song they want to sound like, import_reference it and use compare_to_reference.
The studio also reports what the user does: get_events / wait_for_event (phrases they play, selections, edits, questions). The resource openband://project holds the song and notifies subscribers after each change.

Conventions:
- 4/4 time. Bars are 1-based (bar 1 = the very start). One bar = 4 beats.
- Inside a region, note "start" and "duration" are in BEATS relative to the region start (0 = first beat of the region; 0.25 = a 16th note; 0.5 = an 8th).
- Pitches: MIDI numbers (60 = C4 = middle C) or names like "C4", "F#3", "Bb2". On drum tracks use names: kick, snare, clap, rim, hihat, openhat, lowtom, midtom, hightom, crash, ride.
- velocity 0..1. Track volume 0..1 (0.8 = unity), pan -1..1, reverb/delay/tone 0..1.

Typical workflow: get_project → set_tempo/set_key → add_track (list_instruments for ids) → add_drum_pattern / add_chord_progression / add_region with notes → duplicate_region to extend → update_track to mix → transport play.
Prefer few, musically complete calls (e.g. a whole 4-bar melody in one add_region). Always reuse ids returned by previous calls.

Imported sounds: import_sample loads an audio file (local path or URL) and returns a sample_id. Use it to build instruments with create_sampler_instrument (melodic sampler or drum kit), or put it on the timeline with add_audio_region (audio tracks). import_soundfont lists the presets of a .sf2 file, then imports one as an instrument. Imported instruments get ids like "usr_..." that work in add_track / update_track.

Mixing: set_track_effects adds an amp sim, 3-band EQ and compressor to a track; set_automation draws curves for volume, pan, tone, reverb or echo over time (e.g. fades, filter sweeps, auto-pan).
Recording: record_audio records the user's microphone after they confirm (mode "hum" turns a hummed melody into MIDI); audio_to_midi converts an existing monophonic audio region into notes.
Files: export_wav and export_midi download in the browser, or write to disk with save_to; import_midi turns a .mid file into tracks.
Plugins: Web Audio Modules (WAM 2.0) instruments and effects. When the user describes a sound or effect in words, call add_plugin with that description (or search_plugins first to compare options); then get_plugin_params / set_plugin_params to dial it in.`;

const server = new McpServer({ name: 'openband', version: PKG.version }, { instructions: INSTRUCTIONS });

// Tool annotations, set in one place for every tool. In MCP, destructiveHint and openWorldHint default to
// true, so they are always given explicitly.
/** Tools that throw away or replace work (undo still works in the studio, but the AI should ask first). */
const DESTRUCTIVE = new Set(['new_project', 'import_project_json', 'delete_track', 'delete_region', 'remove_notes', 'delete_section', 'delete_take', 'delete_annotation', 'clear_automation', 'clear_reference', 'remove_plugin_effect', 'checkout', 'merge', 'import_midi', 'join_room', 'import_dawproject', 'restore_at', 'delete_flub']);
/** Tools that reach the internet: URL imports and the community plugin catalog, multiplayer rooms. */
const OPEN_WORLD = new Set(['import_sample', 'import_soundfont', 'import_midi', 'import_reference', 'import_dawproject', 'list_plugins', 'search_plugins', 'add_plugin', 'add_plugin_instrument', 'add_plugin_effect', 'create_room', 'join_room', 'search_loops', 'add_loop']);
function annotationsFor(name, given = {}) {
  const readOnly = !!given.readOnlyHint;
  return { ...given, readOnlyHint: readOnly, ...(readOnly ? {} : { destructiveHint: DESTRUCTIVE.has(name) }), openWorldHint: OPEN_WORLD.has(name) };
}
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
function notifyProjectResource() {
  if (subscriptions.has(PROJECT_URI)) server.server.sendResourceUpdated({ uri: PROJECT_URI }).catch(() => {});
}

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

function tool(name, description, shape, opts = {}) {
  server.registerTool(
    name,
    { title: opts.title, description, inputSchema: shape, annotations: opts.annotations },
    async (args) => {
      try {
        return text(await call(name, args ?? {}, opts.timeout));
      } catch (e) {
        return { ...text(`Error: ${e.message}`), isError: true };
      }
    },
  );
}

const Pitch = z.union([z.number().int().min(0).max(127), z.string()]).describe('MIDI number, note name ("C4", "F#3") or drum name ("kick")');
const NoteSchema = z.object({
  pitch: Pitch,
  start: z.number().min(0).describe('Start in beats from region start'),
  duration: z.number().positive().optional().describe('Length in beats (default 1, drums 0.25)'),
  velocity: z.number().min(0).max(1).optional().describe('0..1, default 0.8'),
});
const readOnly = { annotations: { readOnlyHint: true } };

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

/** A tool whose `source` argument is a file path or URL, shipped to the studio as base64. */
function fileTool(name, description, shape, opts = {}) {
  server.registerTool(
    name,
    { title: opts.title, description, inputSchema: { source: z.string().describe(SAMPLES_DIR ? `File path (absolute, ~/..., or relative to ${SAMPLES_DIR}) or http(s) URL` : 'Absolute file path (or ~/...) or http(s) URL'), ...shape } },
    async ({ source, ...args }) => {
      try {
        const { data, filename } = await readSource(source);
        return text(await call(name, { ...args, filename, data_base64: data.toString('base64') }, opts.timeout ?? 180000));
      } catch (e) {
        return { ...text(`Error: ${e.message}`), isError: true };
      }
    },
  );
}

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

tool('get_project', 'Get the full project: tempo, key, loop, tracks (with ids, instruments, mix) and their regions. Set include_notes to also return every note.', {
  include_notes: z.boolean().optional(),
}, readOnly);

tool('get_status', 'Transport status: playing/recording, playhead position, selection, and whether browser audio is unlocked.', {}, readOnly);

tool('list_instruments', 'List available instrument presets (ids for add_track/update_track), drum piece names and musical keys.', {}, readOnly);

tool('new_project', 'Start a new empty project (the previous one can be restored with undo).', {
  name: z.string().optional(),
  bpm: z.number().min(40).max(240).optional(),
  key: z.string().optional().describe('e.g. "Am", "C", "F#m"'),
});

tool('rename_project', 'Rename the project.', { name: z.string() });
tool('set_tempo', 'Set the tempo in BPM.', { bpm: z.number().min(40).max(240) });
tool('set_key', 'Set the song key shown in the display (e.g. "Am", "Eb").', { key: z.string() });
tool('set_master_volume', 'Set the master output volume 0..1 (0.8 = unity).', { volume: z.number().min(0).max(1) });

tool('add_track', 'Add a track. Give an instrument id (preset or imported, see list_instruments) or just a kind ("audio" for audio clips). Returns track_id.', {
  kind: z.enum(['instrument', 'drums', 'audio']).optional(),
  instrument: z.string().optional(),
  name: z.string().optional(),
});

tool('update_track', 'Change a track: name, instrument preset (same kind), volume 0..1, pan -1..1, mute, solo, reverb 0..1, delay 0..1, tone 0..1 (brightness / low-pass).', {
  track_id: z.string(),
  name: z.string().optional(),
  instrument: z.string().optional(),
  volume: z.number().min(0).max(1).optional(),
  pan: z.number().min(-1).max(1).optional(),
  mute: z.boolean().optional(),
  solo: z.boolean().optional(),
  reverb: z.number().min(0).max(1).optional(),
  delay: z.number().min(0).max(1).optional(),
  tone: z.number().min(0).max(1).optional(),
});

tool(
  'set_track_effects',
  'Set a track\'s insert effects (chain: amp → eq → compressor). Passing a section turns it on unless on:false. amp: drive/tone/level 0..1 (guitar amp + cabinet sim). eq: low/mid/high in dB −15..15, mid_freq 200..6000 Hz. compressor: threshold dB −60..0, ratio 1..20, attack 0.001..0.2 s, release 0.02..1 s, makeup dB 0..24.',
  {
    track_id: z.string(),
    amp: z.object({ on: z.boolean().optional(), drive: z.number().min(0).max(1).optional(), tone: z.number().min(0).max(1).optional(), level: z.number().min(0).max(1).optional() }).optional(),
    eq: z.object({ on: z.boolean().optional(), low: z.number().min(-15).max(15).optional(), mid: z.number().min(-15).max(15).optional(), high: z.number().min(-15).max(15).optional(), mid_freq: z.number().min(200).max(6000).optional() }).optional(),
    compressor: z
      .object({ on: z.boolean().optional(), threshold: z.number().min(-60).max(0).optional(), ratio: z.number().min(1).max(20).optional(), attack: z.number().min(0.001).max(0.2).optional(), release: z.number().min(0.02).max(1).optional(), makeup: z.number().min(0).max(24).optional() })
      .optional(),
  },
);

tool(
  'set_automation',
  'Draw an automation curve on a track parameter: volume 0..1 (0.8 = unity), pan -1..1, tone 0..1, reverb 0..1, echo 0..1. Points are {bar (1-based, fractional ok) or beat (0-based from song start), value}; values are interpolated linearly and held before the first / after the last point. Replaces the curve unless replace is false. Example fade-in: [{bar:1,value:0},{bar:3,value:0.8}].',
  {
    track_id: z.string(),
    param: z.enum(['volume', 'pan', 'tone', 'reverb', 'echo']),
    points: z.array(z.object({ bar: z.number().min(1).optional(), beat: z.number().min(0).optional(), value: z.number() })).min(1),
    replace: z.boolean().optional(),
  },
);

tool('clear_automation', 'Remove the automation curve of one parameter (or all of them) from a track, returning to the static value.', {
  track_id: z.string(),
  param: z.enum(['volume', 'pan', 'tone', 'reverb', 'echo']).optional(),
});

tool('delete_track', 'Delete a track and all its regions.', { track_id: z.string() });

tool('add_region', 'Create a region (MIDI clip) on a track, optionally with notes. If length_bars is omitted it fits the notes. Returns region_id.', {
  track_id: z.string(),
  start_bar: z.number().min(1).optional().describe('1-based bar, may be fractional'),
  length_bars: z.number().positive().optional(),
  name: z.string().optional(),
  notes: z.array(NoteSchema).optional(),
});

tool('update_region', 'Move, resize, rename a region or move it to another track of the same kind. For audio regions also gain (0..2, 1 = unchanged) and offset_seconds (where playback starts inside the sample).', {
  region_id: z.string(),
  start_bar: z.number().min(1).optional(),
  length_bars: z.number().positive().optional(),
  name: z.string().optional(),
  track_id: z.string().optional(),
  gain: z.number().min(0).max(2).optional(),
  offset_seconds: z.number().min(0).optional(),
});

tool('delete_region', 'Delete a region.', { region_id: z.string() });

tool('duplicate_region', 'Repeat a region right after itself `times` times (default 1). Great for extending loops.', {
  region_id: z.string(),
  times: z.number().int().min(1).max(64).optional(),
});

tool('get_region_notes', 'Get all notes of a region (beats relative to region start).', { region_id: z.string() }, readOnly);

tool('add_notes', 'Add notes to an existing region (replace: true to overwrite all notes). The region grows to fit unless extend is false.', {
  region_id: z.string(),
  notes: z.array(NoteSchema),
  replace: z.boolean().optional(),
  extend: z.boolean().optional(),
});

tool('remove_notes', 'Remove notes from a region, filtered by note_ids and/or pitch and/or beat range [from_beat, to_beat). With no filter it clears the region.', {
  region_id: z.string(),
  note_ids: z.array(z.string()).optional(),
  pitch: Pitch.optional(),
  from_beat: z.number().optional(),
  to_beat: z.number().optional(),
});

tool('update_notes', 'Change existing notes in place (keeping their ids): pitch, start (beats from region start), duration, velocity. Only the given fields change.', {
  region_id: z.string(),
  notes: z.array(z.object({ id: z.string(), pitch: Pitch.optional(), start: z.number().min(0).optional(), duration: z.number().positive().optional(), velocity: z.number().min(0).max(1).optional() })).min(1),
});

tool('transpose_region', 'Transpose all notes in a region by semitones.', { region_id: z.string(), semitones: z.number().int().min(-48).max(48) });

tool('quantize_region', 'Snap note starts/lengths in a region to a grid in beats (0.25 = 16th, 0.5 = 8th).', {
  region_id: z.string(),
  grid: z.number().positive().optional(),
});

tool(
  'add_drum_pattern',
  'Create a drum region from step strings on a drums track. Each key is a drum piece, each value a step string: "x" hit, "X" accent, "o" ghost, "." or "-" rest. Spaces and "|" are ignored. Strings repeat to fill `bars`. Example (16 steps/bar): {"kick":"x...x...x...x...","snare":"....x.......x...","hihat":"x.x.x.x.x.x.x.x."}',
  {
    track_id: z.string(),
    pattern: z.record(z.string(), z.string()),
    start_bar: z.number().min(1).optional(),
    bars: z.number().int().min(1).max(64).optional(),
    steps_per_bar: z.number().int().min(1).max(64).optional().describe('default 16; use 12 or 24 for triplet feels'),
    name: z.string().optional(),
  },
);

tool(
  'add_chord_progression',
  'Create a region of chords on an instrument track from chord symbols (C, Am, F#m7, Bbmaj7, Dsus4, G7, Cadd9, C/E, Bdim, Eaug, ...). Use "-" for a rest. style: block (sustained), arpeggio (8th notes), stabs (off-beat hits).',
  {
    track_id: z.string(),
    chords: z.array(z.string()).min(1),
    start_bar: z.number().min(1).optional(),
    beats_per_chord: z.number().positive().optional().describe('default 4 (one bar per chord)'),
    octave: z.number().int().min(1).max(6).optional().describe('octave of the chord root, default 3'),
    style: z.enum(['block', 'arpeggio', 'stabs']).optional(),
    velocity: z.number().min(0).max(1).optional(),
    name: z.string().optional(),
  },
);

tool('transport', 'Control playback: play, stop, toggle or rewind. Optionally jump to from_bar first.', {
  action: z.enum(['play', 'stop', 'toggle', 'rewind']),
  from_bar: z.number().min(1).optional(),
});

tool('set_loop', 'Set the cycle (loop) range in bars; end_bar is exclusive (1..5 loops bars 1-4).', {
  enabled: z.boolean().optional(),
  start_bar: z.number().min(1).optional(),
  end_bar: z.number().min(1).optional(),
});

tool('set_metronome', 'Turn the metronome click on or off.', { enabled: z.boolean() });
tool('open_editor', 'Select a region and show it in the piano roll / step editor so the user can see it.', { region_id: z.string() });
tool('undo', 'Undo the last change (one whole begin_change…end_change step, or one user edit). steps undoes several.', { steps: z.number().int().min(1).max(100).optional() });
tool('redo', 'Redo the last undone change.', { steps: z.number().int().min(1).max(100).optional() });
tool('begin_change', 'Start one undoable change and name it after the user\'s request (e.g. "Lo-fi beat in D minor"). Every command until end_change becomes a single undo step. Closes any change still open.', { label: z.string() });
tool('end_change', 'Close the change opened with begin_change. Returns its label and how many commands it grouped.', {});
tool('get_history', 'The undo history: past and future steps with label, source (ui/ai) and number of commands, plus the change currently open.', { limit: z.number().int().min(1).max(200).optional() }, readOnly);
tool('export_project_json', 'Export the complete project as JSON (for saving or analysis). canonical: true gives deterministic JSON (sorted keys, rounded numbers, sorted notes) for versioning songs with git.', {
  canonical: z.boolean().optional(),
}, readOnly);
tool('import_project_json', 'Replace the current project with an OpenBand project JSON (as produced by export_project_json).', {
  project: z.union([z.string(), z.record(z.string(), z.any())]),
});
/** Exports either download in the browser, or (with save_to) are written to disk by this server. */
function exportTool(name, description) {
  server.registerTool(
    name,
    { description, inputSchema: { save_to: z.string().optional().describe('Optional file path to save to (absolute or ~/...). Without it the browser downloads the file.') } },
    async ({ save_to }) => {
      try {
        if (!save_to) return text(await call(name, {}, 180000));
        const res = await call(name, { return_data: true }, 180000);
        let file = path.resolve(save_to.replace(/^~(?=$|[\/])/, os.homedir()));
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, res.filename);
        await fs.promises.writeFile(file, Buffer.from(res.data_base64, 'base64'));
        return text({ saved: file, bytes: res.bytes });
      } catch (e) {
        return { ...text(`Error: ${e.message}`), isError: true };
      }
    },
  );
}

exportTool('export_wav', 'Render the whole song offline (instruments, imported sounds, audio tracks, effects and automation) as a 16-bit stereo WAV.');
exportTool('export_midi', 'Export the song as a Standard MIDI File (format 1): one track per instrument/drum track with General MIDI programs, drums on channel 10. Audio tracks are not included.');
fileTool('import_midi', 'Import a MIDI file (.mid): each part becomes a track with the closest OpenBand instrument (channel 10 → drums). Adds to the current song unless replace is true; the song tempo is used when the project is empty or replaced.', {
  replace: z.boolean().optional(),
});

// ---- song structure

const SectionKind = z.enum(['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'solo', 'breakdown', 'outro', 'custom']);
tool('get_structure', 'The song\'s sections (id, name, kind, start_bar, length_bars) with an energy profile each: active tracks, notes per bar (total and per track), mean velocity and register, and loudness when a full analysis is cached.', {}, readOnly);
tool('add_section', 'Mark a section of the song (sections never overlap).', { name: z.string(), kind: SectionKind, start_bar: z.number().min(1), length_bars: z.number().positive() });
tool('update_section', 'Rename, re-type, move or resize a section marker (content is not moved; use move_section for that).', {
  section_id: z.string(), name: z.string().optional(), kind: SectionKind.optional(), start_bar: z.number().min(1).optional(), length_bars: z.number().positive().optional(),
});
tool('delete_section', 'Remove a section marker; with delete_content also the music inside it (regions are split at the boundaries).', { section_id: z.string(), delete_content: z.boolean().optional() });
tool('move_section', 'Move a section WITH its content (regions split at the boundaries, automation follows) so it starts at to_bar (bar on the current timeline, e.g. the bar after another section). With ripple (default) the rest of the song closes the gap and makes room.', {
  section_id: z.string(), to_bar: z.number().min(1), ripple: z.boolean().optional(),
});
tool('duplicate_section', 'Copy a section with its content, by default right after itself ("one more chorus"), or at to_bar. With ripple (default) what follows moves later.', {
  section_id: z.string(), to_bar: z.number().min(1).optional(), ripple: z.boolean().optional(),
});
tool('split_region', 'Split a region in two at a bar (or beat): notes crossing the cut are shortened, later notes go to the new region.', {
  region_id: z.string(), at_bar: z.number().min(1).optional(), at_beat: z.number().min(0).optional(),
});
tool('auto_sections', 'Propose sections (intro, verse, chorus…) from repetitions in the music and silences. Changes nothing: add the ones you like with add_section.', {}, readOnly);

// ---- lyrics

tool('set_lyrics', 'Write lyrics: text with one line per verse line ("\\n" separated). For a section (section_id) its lines are replaced; with line_ids those lines are rewritten; otherwise all lyrics. Italian lyrics get metric syllables with synalepha; mark a melisma with "_" after a syllable. Lines are re-aligned to the melody if a melody track is set.', {
  text: z.string(), section_id: z.string().optional(), line_ids: z.array(z.string()).optional(), language: z.enum(['it', 'en']).optional(),
});
tool('get_lyrics', 'The lyrics: lines with syllables (stressed or not), the bar and note each syllable sits on, and whether each line is aligned.', { section_id: z.string().optional() }, readOnly);
tool('align_lyrics', 'Put the syllables on the notes of the melody track, in order (per section when lines belong to sections). Returns syllables or notes left over and the number of prosody issues.', {
  melody_track_id: z.string(), section_id: z.string().optional(),
});
tool('check_prosody', 'Check that melody and words fit: syllables vs notes per phrase, stressed syllables on weak beats, long notes on unstressed endings, words cut by rests.', { section_id: z.string().optional() }, readOnly);
tool('suggest_melody_rhythm', 'A rhythm for a lyric line (start and duration in beats per syllable) with stressed syllables on beats and a long final note — a starting point to write the melody with add_region / add_notes.', { line_id: z.string() }, readOnly);
server.registerTool(
  'export_chord_sheet',
  {
    description: 'Export a chord sheet built from sections, the detected chords and the lyrics: ChordPro (.cho) or plain text with chords over the lyrics. Returns the text; with save_to it is also written to that path, otherwise the browser downloads it.',
    inputSchema: { format: z.enum(['chordpro', 'txt']).optional(), save_to: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ format, save_to }) => {
    try {
      const res = await call('export_chord_sheet', { format, return_data: !!save_to });
      if (save_to) {
        let file = path.resolve(save_to.replace(/^~(?=$|[\\/])/, os.homedir()));
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, res.filename);
        await fs.promises.writeFile(file, res.text);
        return text({ saved: file, format: res.format, text: res.text });
      }
      return text(res.text);
    } catch (e) {
      return { ...text(`Error: ${e.message}`), isError: true };
    }
  },
);

// ---- musical linter

const Severity = z.enum(['info', 'warn', 'error']);
tool(
  'lint_project',
  'Check the song for musical problems: notes out of key, overlapping notes/regions, notes past the region end, low-end clashes, crowded registers, mechanical velocity/timing, empty tracks, panned bass, gaps between sections; with include_audio also clipping, headroom, low-end masking and phase (renders the mix). Each issue has a stable id, a target and often an automatic fix.',
  { rules: z.array(z.string()).optional(), include_audio: z.boolean().optional(), min_severity: Severity.optional() },
  { ...readOnly, timeout: 180000 },
);
tool('apply_fix', 'Apply the automatic fix of a lint issue (one undo step). Returns what was done.', { issue_id: z.string() });
tool('ignore_issue', 'Stop reporting a lint issue for this song (stored in the project).', { issue_id: z.string() });

// ---- listening: mix analysis

const RangeArgs = {
  from_bar: z.number().min(1).optional(),
  to_bar: z.number().min(1).optional().describe('exclusive'),
  section_id: z.string().optional(),
};

tool(
  'analyze_mix',
  'LISTEN to the mix: renders the song (or a bar range / section) and measures it. Returns master loudness (integrated/short-term LUFS, LRA, true peak, crest), stereo (correlation, width, mono loss), energy per band (sub, bass, lowmid, mid, highmid, presence, air), per-track loudness/peak/dominant band/share of the mix, masking between tracks, the detected key, and concrete issues with suggestions. detail "full" adds 1/3-octave curves and loudness per bar.',
  { ...RangeArgs, per_track: z.boolean().optional().describe('default true'), detail: z.enum(['summary', 'full']).optional() },
  { ...readOnly, timeout: 180000 },
);

server.registerTool(
  'render_spectrogram',
  {
    description: 'Render a spectrogram image (log frequency 30 Hz–16 kHz, bar grid, section names) of the mix or of one track, so you can SEE the arrangement: where instruments sit, density, gaps, harshness.',
    inputSchema: { ...RangeArgs, track_id: z.string().optional(), width: z.number().int().min(256).max(2048).optional(), height: z.number().int().min(128).max(1024).optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const r = await call('render_spectrogram', args ?? {}, 180000);
      return { content: [{ type: 'image', data: r.png_base64, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ width: r.width, height: r.height, from_bar: r.from_bar, to_bar: r.to_bar }) }] };
    } catch (e) {
      return { ...text(`Error: ${e.message}`), isError: true };
    }
  },
);

tool('analyze_harmony', 'Chords of the MIDI parts (per bar, or per half bar when they change), with Roman numerals in the project key (I, ii7, V7/V, bVII…), harmonic function and confidence, plus cadences (authentic, plagal, ii–V–I, deceptive, half) — at section ends when sections exist. Drums are excluded.', {
  ...RangeArgs, track_ids: z.array(z.string()).optional(),
}, readOnly);

tool('detect_key', 'Detect the key of the music from the MIDI notes, from the audio tracks, or both. Returns key, confidence, alternatives and whether it matches the project key.', {
  source: z.enum(['midi', 'audio', 'both']).optional(),
}, { ...readOnly, timeout: 180000 });

// ---- multiplayer rooms

tool('create_room', 'Open a multiplayer room for this song and return a link to share (plus the password, if you set one, which the user must share separately). via "lan" uses this server as relay (needs OPENBAND_COLLAB=1, people on the same network), "p2p" connects browsers directly (WebRTC). Your commands keep working: you act through this browser and everyone sees the changes; undo only takes back each person\'s own work.', {
  password: z.string().optional(),
  via: z.enum(['lan', 'p2p']).optional(),
}, { timeout: 30000 });

tool('join_room', 'Join an existing multiplayer room (the room name from a link, and its password if it has one). The song of the room replaces the open one.', {
  room: z.string(),
  password: z.string().optional(),
  via: z.enum(['lan', 'p2p']).optional(),
}, { timeout: 30000 });

tool('leave_room', 'Leave the multiplayer room (the song stays open locally).', {});

tool('get_peers', 'Who is in the room: names, who hosts, who has an AI connected, the track each person has selected, and where their playhead is.', {}, readOnly);

// ---- jam: call-and-response

tool('play_phrase', 'Answer what the user played: the notes (beats from the phrase start, like add_region) are played live on a track at the next musical window — next_bar (default), next_loop (the cycle start) or {bar} — never earlier, and if your answer arrives too late it moves to the following window. The notes are NOT added to the song unless commit:true (the user can also press Keep). Returns when it will start.', {
  track_id: z.string().optional().describe('Default: the jam response track'),
  notes: z.array(NoteSchema),
  at: z.union([z.enum(['next_bar', 'next_loop']), z.object({ bar: z.number().int().min(1) })]).optional(),
  commit: z.boolean().optional(),
});

tool('set_jam_mode', 'Turn jam (call-and-response) mode on or off: the studio shows that you are listening, and play_phrase defaults to response_track_id and window. Then loop: wait_for_event({kinds:["phrase"]}) → compose an answer → play_phrase.', {
  enabled: z.boolean(),
  response_track_id: z.string().optional(),
  window: z.enum(['next_bar', 'next_loop']).optional(),
});

tool('keep_answer', 'Keep the last answer played with play_phrase: its notes are added to the song (one undo step).', {});

// ---- versions and branches

tool('save_version', 'Save the current state of the song as a version on the current branch (like a commit). Do it before big changes, so the user can go back.', { label: z.string().optional() });

tool('list_versions', 'List saved versions (newest first) with branch, label, author, parents, which one is HEAD, and whether there are unsaved changes.', { branch: z.string().optional() }, readOnly);

tool('create_branch', 'Create a branch (an alternative direction for the song) from a version (default: HEAD). It does not switch to it: call checkout.', {
  name: z.string(),
  from_version_id: z.string().optional(),
});

tool('checkout', 'Switch the song to a branch (its latest version) or to a version. Unsaved changes are saved first as a "WIP" version. Undoable.', {
  branch: z.string().optional(),
  version_id: z.string().optional(),
});

tool('diff_versions', 'What changed between two versions (ids, branch names or "HEAD"); b defaults to the current state. Returns a readable summary ("Bass: 12 notes changed in Chorus; tempo 82→86") and structured changes.', {
  a: z.string(),
  b: z.string().optional(),
}, readOnly);

tool('merge', 'Three-way merge of a branch into the current one: changes made on only one side are combined; when both changed the same thing it is a conflict. strategy: manual (default: conflicts are returned and our side is kept), ours or theirs. pick resolves specific entities, e.g. [{entity:"region", id:"rgn_x", from:"b"}] = take that region from the other branch; for a track field use id "trk_x.volume"; project fields by name ("bpm"). Without conflicts a merge version is saved.', {
  from_branch: z.string(),
  strategy: z.enum(['manual', 'ours', 'theirs']).optional(),
  pick: z.array(z.object({ entity: z.enum(['project', 'track', 'region', 'section', 'lyrics', 'instrument', 'annotation']), id: z.string(), from: z.enum(['a', 'b']) })).optional(),
});

// ---- annotations ("Explain" mode)

const TargetSchema = z.object({
  type: z.enum(['project', 'track', 'region', 'notes', 'section', 'range']),
  id: z.string().optional().describe('track/region/section id (for notes: the region, optional)'),
  note_ids: z.array(z.string()).optional(),
  from_beat: z.number().min(0).optional(),
  to_beat: z.number().min(0).optional(),
}).describe('What the annotation is about. Ranges are in beats from the song start (bar n starts at beat (n-1)*4).');

tool('annotate', 'Attach a short explanation (markdown, max 500 characters) to part of the song: why a chord, voicing, rhythm or mix choice works. It appears as a pin on the arrangement / piano roll and in the Comments panel. Answer "Explain" questions (ask events with context.explain) this way.', {
  target: TargetSchema,
  text: z.string().max(500),
});

tool('list_annotations', 'List annotations (optionally only those about a target; resolved ones only with include_resolved). Annotations whose target was deleted are marked orphaned.', {
  target: TargetSchema.partial().optional(),
  include_resolved: z.boolean().optional(),
}, readOnly);

tool('resolve_annotation', 'Mark an annotation as resolved (or resolved=false to reopen it).', { annotation_id: z.string(), resolved: z.boolean().optional() });

tool('delete_annotation', 'Delete an annotation.', { annotation_id: z.string() });

// ---- takes

const NotesArg = z.array(NoteSchema);

tool('add_take', 'Add an alternative version (take) of a MIDI region, e.g. 4 bass variations = 4 add_take calls inside one begin_change. The region\'s current content becomes "Take 1" the first time. The new take becomes active unless activate=false. Notes as in add_region (beats from the region start).', {
  region_id: z.string(),
  notes: NotesArg,
  name: z.string().optional(),
  activate: z.boolean().optional(),
});

tool('list_takes', 'List the takes of a region (id, name, author, number of notes, which is active).', { region_id: z.string() }, readOnly);

tool('set_active_take', 'Make a take the one that plays (by id or name).', { region_id: z.string(), take_id: z.string() });

tool('delete_take', 'Delete a take from a region.', { region_id: z.string(), take_id: z.string() });

tool('comp_takes', 'Build a "Comp" take from stretches of several takes: segments [{from_beat, to_beat, take_id}] in beats from the region start, non-overlapping. Notes are cut at the segment boundaries. The comp becomes active.', {
  region_id: z.string(),
  segments: z.array(z.object({ from_beat: z.number().min(0), to_beat: z.number().min(0), take_id: z.string() })).min(1),
  name: z.string().optional(),
});

tool('start_ab_test', 'Open a blind A/B listening test of 2–4 takes of a region (default: its last 4): the user hears them as A/B/C/D in random order while the region loops, ranks them, and only then sees the names. Returns test_id. The result arrives as an "ab_result" event with the take ids ranked best first (empty if cancelled): wait_for_event({kinds:["ab_result"]}).', {
  region_id: z.string(),
  take_ids: z.array(z.string()).min(2).max(4).optional(),
  loop: z.boolean().optional(),
}, readOnly);

// ---- reference track

fileTool('import_reference', 'Load a reference song (a commercial track the user wants to sound like) for mix matching. It is not put on the timeline. Optional from_seconds/to_seconds pick an excerpt (e.g. the chorus). Returns its loudness, dynamics, stereo width and band balance.', {
  from_seconds: z.number().min(0).optional(),
  to_seconds: z.number().min(0).optional(),
});

tool('compare_to_reference', 'Compare the mix (or bars / a section of it) with the reference track, after matching their loudness: loudness_diff_lu, crest_diff_db, width_diff, tonal_diff_db per band (mix minus reference; negative = the mix has less) and concrete suggestions (EQ on the master or on the track that has the most energy in a band, gain, compression, width).', {
  ...RangeArgs,
}, { ...readOnly, timeout: 180000 });

tool('clear_reference', 'Remove the reference track from the project.', {});

// ---- recording

tool('record_audio', 'Record from the user\'s microphone, with a one-bar count-in, starting at start_bar. The user is always asked to confirm in the studio first (returns {recorded:false} if they decline). mode "audio" makes an audio region; mode "hum" also turns the hummed/sung melody into MIDI notes on a new instrument track (the audio is kept, muted). Without bars, recording runs until the user presses stop.', {
  mode: z.enum(['audio', 'hum']).optional(),
  track_id: z.string().optional().describe('Audio track to record onto (default: a new one)'),
  start_bar: z.number().int().min(1).optional(),
  bars: z.number().int().min(1).max(64).optional(),
}, { timeout: 600000 });

tool('audio_to_midi', 'Convert a monophonic audio region (voice, whistle, bass, lead) into MIDI notes: YIN pitch tracking, note segmentation, optional snap to the project key and quantize with strength. The MIDI region is placed at the same position as the audio. Returns the notes.', {
  region_id: z.string().optional(),
  sample_id: z.string().optional(),
  start_bar: z.number().int().min(1).optional().describe('With sample_id: where to place the notes'),
  track_id: z.string().optional().describe('Instrument track for the notes (default: a new one)'),
  instrument: z.string().optional(),
  snap_to_key: z.boolean().optional(),
  quantize: z.number().min(0).max(4).optional().describe('Grid in beats, 0 = off (default 0.25)'),
  strength: z.number().min(0).max(1).optional(),
}, { timeout: 180000 });

// ---- studio → AI events (answered by this server, not the studio)

const EventKind = z.enum(['phrase', 'selection', 'transport', 'user_edit', 'region_recorded', 'ask', 'ab_result']);

server.registerTool(
  'get_events',
  {
    description: 'What the user has been doing in the studio, oldest first: phrases played live (notes in beats from the phrase\'s first bar), selection changes, transport, finished edits, recorded regions and questions asked with "Ask the AI". Pass since_id (the last_id you got) to get only new ones.',
    inputSchema: { since_id: z.number().int().optional(), kinds: z.array(EventKind).optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => text(events.list(args)),
);

server.registerTool(
  'wait_for_event',
  {
    description: 'Wait (long-poll, up to 60 s) for the next studio event of the given kinds, e.g. {kinds:["phrase"]} to answer what the user plays, or ["ask"] for questions. Returns the event, or {timeout:true}. With since_id, an event already received after it is returned immediately.',
    inputSchema: { kinds: z.array(EventKind).optional(), timeout_ms: z.number().int().min(0).max(60000).optional(), since_id: z.number().int().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => text(await events.wait(args)),
);

// ---- WAM plugins (Web Audio Modules 2.0, the web's open plugin standard)

tool('list_plugins', 'List the Web Audio Module plugins available from the community collection: id, name, vendor, kind (instrument/effect), description.', {
  kind: z.enum(['instrument', 'effect']).optional(),
}, { ...readOnly, timeout: 30000 });

tool('search_plugins', 'Find WAM plugins from a plain-language description in English or Italian (e.g. "warm tube overdrive for guitar", "riverbero ampio e scuro", "monophonic analog synth"). Returns ranked matches with a score.', {
  description: z.string(),
  kind: z.enum(['instrument', 'effect']).optional(),
}, { ...readOnly, timeout: 30000 });

tool(
  'add_plugin',
  'Add a WAM plugin by simply describing it (or by id/URL via plugin). The best match is added: instruments get a new track (or replace the instrument of track_id), effects are appended to track_id (or the selected track) after Amp → EQ → Compressor. Returns what was added plus alternatives.',
  {
    description: z.string().optional().describe('What you want, in words, e.g. "a shimmering ambient reverb"'),
    plugin: z.string().optional().describe('Exact plugin id, name or index.js URL instead of a description'),
    track_id: z.string().optional(),
    kind: z.enum(['instrument', 'effect']).optional(),
  },
  { timeout: 60000 },
);

tool('add_plugin_instrument', 'Load a WAM instrument plugin (id, name or index.js URL). Creates a track, or replaces the instrument of track_id. Returns instrument_id and track_id.', {
  plugin: z.string(),
  track_id: z.string().optional(),
}, { timeout: 60000 });

tool('add_plugin_effect', 'Append a WAM effect plugin (id, name or index.js URL) to a track\'s effect chain. Returns slot_id.', {
  track_id: z.string(),
  plugin: z.string(),
}, { timeout: 60000 });

tool('remove_plugin_effect', 'Remove a WAM effect from a track.', { track_id: z.string(), slot_id: z.string() });
tool('set_plugin_bypass', 'Turn a WAM effect on or off without removing it.', { track_id: z.string(), slot_id: z.string(), on: z.boolean() });

tool('get_plugin_params', 'List the parameters of a loaded plugin (id, label, value, range, units, choices). Omit slot_id for the track\'s plugin instrument.', {
  track_id: z.string(),
  slot_id: z.string().optional(),
}, { ...readOnly, timeout: 30000 });

tool('set_plugin_params', 'Set parameters of a loaded plugin: values maps parameter id (or label) to a value in the parameter\'s own range. Omit slot_id for the plugin instrument.', {
  track_id: z.string(),
  slot_id: z.string().optional(),
  values: z.record(z.string(), z.number()),
}, { timeout: 30000 });

tool('show_plugin', 'Open the plugin\'s own window in the studio so the user can see and tweak it. Omit slot_id for the plugin instrument.', {
  track_id: z.string(),
  slot_id: z.string().optional(),
});

// ---- imported sounds

fileTool('import_sample', 'Load an audio file (WAV, MP3, OGG, FLAC, AIFF…) into the studio. Returns sample_id, duration and the detected root note (from the file name or the pitch).', {});

tool('list_samples', 'List the samples loaded in the studio (ids, names, durations).', {}, readOnly);

tool(
  'create_sampler_instrument',
  'Build a playable instrument from imported samples. Melodic (kind "instrument"): samples [{sample_id, root?, lo?, hi?}] — without lo/hi each sample covers the keys nearest its root. Drum kit (kind "drums"): pads {kick: sample_id, snare: ..., hihat, openhat, clap, rim, lowtom, midtom, hightom, crash, ride}, or samples to auto-assign by name. Returns instrument_id for add_track/update_track.',
  {
    name: z.string().optional(),
    kind: z.enum(['instrument', 'drums']).optional(),
    samples: z.array(z.object({ sample_id: z.string(), root: z.union([z.number().int(), z.string()]).optional(), lo: z.number().int().optional(), hi: z.number().int().optional() })).optional(),
    pads: z.record(z.string(), z.string()).optional(),
    attack: z.number().min(0).max(5).optional().describe('seconds'),
    release: z.number().min(0).max(10).optional().describe('seconds'),
  },
);

fileTool('import_soundfont', 'Import from a SoundFont 2 (.sf2) file. Without preset it lists the presets (index, name, bank:program). With preset (index, name or "bank:program") it imports that preset as an instrument and returns instrument_id.', {
  preset: z.union([z.string(), z.number()]).optional(),
});

tool('add_audio_region', 'Place an imported sample on the timeline as an audio clip. Without track_id a new audio track is created. Length defaults to the sample length (audio is not time-stretched).', {
  sample_id: z.string(),
  track_id: z.string().optional(),
  start_bar: z.number().min(1).optional(),
  name: z.string().optional(),
  offset_seconds: z.number().min(0).optional(),
  length_bars: z.number().positive().optional(),
  gain: z.number().min(0).max(2).optional(),
});

if (STDIO) {
  await server.connect(new StdioServerTransport());
  log('MCP server ready');
} else {
  log(`studio on ${studioUrl()}`);
  if (OPEN_BROWSER) openBrowser();
}
