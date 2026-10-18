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
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const PORT = Number(process.env.OPENBAND_PORT || 7777);
const HOST = '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DEV_URL = process.env.OPENBAND_DEV_URL || 'http://localhost:5173';
const log = (...a) => console.error('[openband]', ...a);

// ---------------------------------------------------------------- HTTP + WebSocket bridge

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav' };

const httpServer = http.createServer((req, res) => {
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

const isLocalOrigin = (origin) => !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

const wss = new WebSocketServer({
  server: httpServer,
  path: '/bridge',
  verifyClient: ({ origin }) => isLocalOrigin(origin),
});

/** @type {import('ws').WebSocket | null} */
let studio = null;
const pending = new Map();
let seq = 0;
let bridgeError = null;

wss.on('connection', (ws) => {
  studio = ws; // the most recent tab wins
  log('studio connected');
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
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
httpServer.listen(PORT, HOST, () => log(`bridge on ws://${HOST}:${PORT}/bridge`));

const studioUrl = () => (fs.existsSync(DIST) ? `http://${HOST}:${PORT}` : DEV_URL) + (PORT !== 7777 ? `?mcp=${PORT}` : '');

function waitForStudio(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (studio || Date.now() - t0 > ms ? resolve(!!studio) : setTimeout(tick, 250));
    tick();
  });
}

async function call(method, params = {}, timeoutMs = 20000) {
  if (bridgeError) throw new Error(bridgeError);
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

Conventions:
- 4/4 time. Bars are 1-based (bar 1 = the very start). One bar = 4 beats.
- Inside a region, note "start" and "duration" are in BEATS relative to the region start (0 = first beat of the region; 0.25 = a 16th note; 0.5 = an 8th).
- Pitches: MIDI numbers (60 = C4 = middle C) or names like "C4", "F#3", "Bb2". On drum tracks use names: kick, snare, clap, rim, hihat, openhat, lowtom, midtom, hightom, crash, ride.
- velocity 0..1. Track volume 0..1 (0.8 = unity), pan -1..1, reverb/delay/tone 0..1.

Typical workflow: get_project → set_tempo/set_key → add_track (list_instruments for ids) → add_drum_pattern / add_chord_progression / add_region with notes → duplicate_region to extend → update_track to mix → transport play.
Prefer few, musically complete calls (e.g. a whole 4-bar melody in one add_region). Always reuse ids returned by previous calls.

Imported sounds: import_sample loads an audio file (local path or URL) and returns a sample_id. Use it to build instruments with create_sampler_instrument (melodic sampler or drum kit), or put it on the timeline with add_audio_region (audio tracks). import_soundfont lists the presets of a .sf2 file, then imports one as an instrument. Imported instruments get ids like "usr_..." that work in add_track / update_track.`;

const server = new McpServer({ name: 'openband', version: '0.1.0' }, { instructions: INSTRUCTIONS });

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
  const file = path.resolve(source.replace(/^~(?=$|[\/])/, os.homedir()));
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`File not found: ${file}`);
  if (stat.size > MAX_IMPORT_BYTES) throw new Error('File too large (max 200 MB)');
  return { data: await fs.promises.readFile(file), filename: path.basename(file) };
}

/** A tool whose `source` argument is a file path or URL, shipped to the studio as base64. */
function fileTool(name, description, shape, opts = {}) {
  server.registerTool(
    name,
    { title: opts.title, description, inputSchema: { source: z.string().describe('Absolute file path (or ~/...) or http(s) URL'), ...shape } },
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
    const url = studioUrl();
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    } catch (e) {
      return { ...text(`Could not open a browser: ${e.message}. Ask the user to open ${url}`), isError: true };
    }
    const ok = await waitForStudio(15000);
    return text(
      ok
        ? { connected: true, url, note: 'Ask the user to click "Enter the studio" once so the browser allows audio.' }
        : { connected: false, url, note: `Opened ${url} but the studio has not connected yet. If you are in dev mode make sure "npm run dev" is running.` },
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
tool('undo', 'Undo the last change.', {});
tool('redo', 'Redo the last undone change.', {});
tool('export_project_json', 'Export the complete project as JSON (for saving or analysis).', {}, readOnly);
tool('import_project_json', 'Replace the current project with an OpenBand project JSON (as produced by export_project_json).', {
  project: z.union([z.string(), z.record(z.string(), z.any())]),
});
tool('export_wav', 'Render the whole song offline (instruments, imported sounds and audio tracks) and download it as a WAV file in the browser.', {}, { timeout: 180000 });

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

await server.connect(new StdioServerTransport());
log('MCP server ready');
