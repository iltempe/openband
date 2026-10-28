#!/usr/bin/env node
// A mock OMEP 1.0 engine: a real MCP server (stdio) with three capabilities, deterministic for a seed.
//   symbolic.drums      a kick / snare / hi-hat groove over the scope, as notes
//   symbolic.accompany  block chords that follow the harmony, inside the range
//   music.add_layer     an arpeggiated plucked layer over the harmony, as a WAV file
// Every tool supports MCP tasks ("optional": with a task when the client asks, synchronous otherwise).
// Flags that make it misbehave on purpose, to test conformance and the studio's corrections:
//   --wrong-key (everything a semitone up, while claiming the right key)  --wrong-tempo (10% fast)
//   --bad-output (a contribution that breaks the schema)  --slow (tasks take 3 s, to test cancellation)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { EXTENSION } from './lib/schemas.mjs';
import { beatsPerBar, noteNumber, parseChord, parseKey, scalePcs } from './lib/music.mjs';
import { decodeWav, encodeWav } from './lib/audio.mjs';

const flags = new Set(process.argv.slice(2));
const SHIFT = flags.has('--wrong-key') ? 1 : 0;
const TEMPO = flags.has('--wrong-tempo') ? 1.1 : 1;
const DELAY = flags.has('--slow') ? 3000 : 20;

const LICENSE = { code: 'MIT', weights: null, commercial: 'yes', attribution: null, conditions: null, url: 'https://github.com/iltempe/openband/blob/main/LICENSE' };
export const MANIFEST = {
  omep: '1.0',
  engine: { id: 'omep-mock', name: 'OMEP mock engine', version: '1.0.0', homepage: 'https://github.com/iltempe/openband/tree/main/omep' },
  license: LICENSE,
  runtime: { where: 'local', device: ['cpu'], realtime: false },
  capabilities: {
    'symbolic.drums': { conditioning: ['bpm', 'meter', 'sections'] },
    'symbolic.accompany': { conditioning: ['key', 'chords', 'range'] },
    'music.add_layer': { conditioning: ['bpm', 'key', 'chords', 'text'], max_seconds: 120 },
    'music.restyle': { conditioning: ['text', 'context_audio'], max_seconds: 600 },
  },
  outputs: ['audio/wav', 'application/x-omep-notes'],
  languages: ['en', 'it'],
  determinism: 'seeded',
};

/** A small seeded random generator (mulberry32). */
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function readContext(ctx) {
  if (typeof ctx === 'string') {
    if (!ctx.startsWith('file://')) throw new Error('The mock engine only reads file:// context URIs');
    return JSON.parse(fs.readFileSync(new URL(ctx), 'utf8'));
  }
  return ctx;
}

/** Scope in beats, the chord sounding at each bar, and the range. */
function frame(scp) {
  const bpb = beatsPerBar(scp.song.meter);
  const from = scp.scope?.from_bar ?? 1;
  const to = scp.scope?.to_bar ?? from + scp.song.length_bars;
  const bars = to - from;
  const key = parseKey(scp.song.key) ?? { tonic: 0, minor: false };
  const fallback = { root: key.tonic, tones: [0, key.minor ? 3 : 4, 7].map((i) => (key.tonic + i) % 12) };
  const chordAt = (bar) => {
    let c = null;
    for (const h of scp.harmony ?? []) if (h.bar <= bar) c = parseChord(h.chord) ?? c;
    return c ?? fallback;
  };
  const [lo, hi] = (scp.constraints?.hard?.range ?? ['C3', 'C6']).map(noteNumber);
  return { bpb, from, bars, beats: bars * bpb, chordAt, lo, hi, key };
}

const voicing = (pcs, lo, hi, around = 60) => pcs.map((pc) => {
  let n = Math.floor(around / 12) * 12 + pc;
  while (n < Math.max(lo, around - 6)) n += 12;
  while (n > hi) n -= 12;
  return n + SHIFT;
});

function drums(scp, seed) {
  const f = frame(scp);
  const r = rng(seed);
  const notes = [];
  for (let bar = 0; bar < f.bars; bar++) {
    const b0 = bar * f.bpb;
    for (let beat = 0; beat < f.bpb; beat++) {
      if (beat % 2 === 0) notes.push({ pitch: 36, start: b0 + beat, duration: 0.25, velocity: 0.9 });
      else notes.push({ pitch: 38, start: b0 + beat, duration: 0.25, velocity: 0.8 });
      for (const off of [0, 0.5]) notes.push({ pitch: 42, start: b0 + beat + off, duration: 0.125, velocity: +(0.45 + r() * 0.2).toFixed(2) });
    }
  }
  return { kind: 'notes', notes, claims: { bpm: scp.song.bpm, length_bars: f.bars, meter: scp.song.meter } };
}

function accompany(scp) {
  const f = frame(scp);
  const notes = [];
  for (let bar = 0; bar < f.bars; bar++) {
    const c = f.chordAt(f.from + bar);
    for (const pitch of voicing(c.tones.slice(0, 4), f.lo, f.hi)) notes.push({ pitch, start: bar * f.bpb, duration: f.bpb, velocity: 0.6 });
  }
  return { kind: 'notes', notes, claims: { key: scp.song.key, length_bars: f.bars } };
}

function addLayer(scp, seed) {
  const f = frame(scp);
  const sr = 48000;
  const spb = 60 / (scp.song.bpm * TEMPO);
  const x = new Float32Array(Math.round(f.beats * spb * sr));
  const r = rng(seed);
  for (let bar = 0; bar < f.bars; bar++) {
    const tones = voicing(f.chordAt(f.from + bar).tones.slice(0, 4), f.lo, f.hi);
    for (let i = 0; i < f.bpb * 2; i++) {
      const pitch = tones[(i + Math.floor(r() * 2)) % tones.length];
      const freq = 440 * 2 ** ((pitch - 69) / 12);
      const at = Math.round((bar * f.bpb + i / 2) * spb * sr);
      const len = Math.round(spb * 0.5 * sr);
      const amp = i === 0 ? 0.5 : 0.32;
      for (let k = 0; k < len && at + k < x.length; k++) {
        const t = k / sr;
        x[at + k] += amp * Math.exp(-t * 7) * (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(4 * Math.PI * freq * t));
      }
    }
  }
  const file = path.join(os.tmpdir(), `omep-mock-${process.pid}-${Date.now().toString(36)}-${seed}.wav`);
  fs.writeFileSync(file, encodeWav([x], sr));
  return { kind: 'audio', files: [{ uri: pathToFileURL(file).href, role: 'layer', format: 'wav', sample_rate: sr, channels: 1 }], alignment: { start_bar: f.from, bpm_detected: scp.song.bpm }, claims: { key: scp.song.key, bpm: scp.song.bpm, length_bars: f.bars } };
}

/** A "cover": the song's own audio, darker (a one-pole low-pass) and with a tremolo on its eighth notes; the same length. */
function restyle(scp) {
  const uri = scp.context_audio?.mix_uri;
  if (!uri) throw new Error('music.restyle needs the song\'s audio (context_audio)');
  const bytes = uri.startsWith('data:') ? Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64') : fs.readFileSync(fileURLToPath(uri));
  const { sampleRate: sr, channels } = decodeWav(bytes);
  const rate = (scp.song.bpm / 60) * 2;
  const out = channels.map((c) => {
    const y = new Float32Array(c.length);
    let lp = 0;
    for (let i = 0; i < c.length; i++) {
      lp += 0.08 * (c[i] - lp);
      y[i] = lp * (0.75 + 0.25 * Math.sin((2 * Math.PI * rate * i) / sr));
    }
    return y;
  });
  const file = path.join(os.tmpdir(), `omep-mock-${process.pid}-${Date.now().toString(36)}-cover.wav`);
  fs.writeFileSync(file, encodeWav(out, sr));
  const f = frame(scp);
  return { kind: 'audio', files: [{ uri: pathToFileURL(file).href, role: 'full', format: 'wav', sample_rate: sr, channels: out.length }], alignment: { start_bar: f.from, bpm_detected: scp.song.bpm }, claims: { key: scp.song.key, bpm: scp.song.bpm, length_bars: f.bars } };
}

const RUN = { 'symbolic.drums': drums, 'symbolic.accompany': accompany, 'music.add_layer': addLayer, 'music.restyle': restyle };

/** The tool result: a contribution as structuredContent, files also as resource links. */
function run(capability, args) {
  const scp = readContext(args.context);
  const seed = args.seed ?? 1;
  const c = RUN[capability](scp, seed);
  const contribution = flags.has('--bad-output')
    ? { kind: c.kind, claims: c.claims }
    : { ...c, provenance: { engine: MANIFEST.engine.id, engine_version: MANIFEST.engine.version, model_hash: 'none', seed, capability }, license: LICENSE };
  return {
    content: [
      { type: 'text', text: `${capability}: ${c.notes ? `${c.notes.length} notes` : `${c.files.length} file(s)`} over ${c.claims.length_bars} bars` },
      ...(c.files ?? []).map((f) => ({ type: 'resource_link', uri: f.uri, name: path.basename(new URL(f.uri).pathname), mimeType: 'audio/wav' })),
    ],
    structuredContent: contribution,
  };
}

const taskStore = new InMemoryTaskStore();
const server = new McpServer(
  { name: 'omep-mock', version: MANIFEST.engine.version },
  { capabilities: { experimental: { [EXTENSION]: { version: '1.0' } }, tasks: { requests: { tools: { call: {} } } } }, taskStore },
);

server.registerResource('manifest', 'omep://manifest', { title: 'OMEP manifest', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(MANIFEST, null, 2) }] }));

const inputShape = {
  context: z.union([z.looseObject({}), z.string()]).describe('Song Context Package (or a file:// URI of one)'),
  request: z.looseObject({}).optional().describe('Capability-specific request'),
  seed: z.number().int().optional(),
  variants: z.number().int().min(1).max(8).optional(),
};

for (const capability of Object.keys(MANIFEST.capabilities)) {
  server.experimental.tasks.registerToolTask(
    capability,
    { title: capability, description: `OMEP ${capability} (mock)`, inputSchema: inputShape, execution: { taskSupport: 'optional' } },
    {
      async createTask(args, { taskStore: store, taskRequestedTtl }) {
        const task = await store.createTask({ ttl: taskRequestedTtl ?? 60000, pollInterval: 50 });
        setTimeout(async () => {
          const now = await store.getTask(task.taskId);
          if (!now || now.status === 'cancelled') return;
          try {
            await store.storeTaskResult(task.taskId, 'completed', run(capability, args));
          } catch (e) {
            await store.storeTaskResult(task.taskId, 'failed', { content: [{ type: 'text', text: e.message }], isError: true });
          }
        }, DELAY);
        return { task };
      },
      async getTask(_args, { taskId, taskStore: store }) {
        return await store.getTask(taskId);
      },
      async getTaskResult(_args, { taskId, taskStore: store }) {
        return await store.getTaskResult(taskId);
      },
    },
  );
}

await server.connect(new StdioServerTransport());
