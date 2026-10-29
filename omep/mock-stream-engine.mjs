#!/usr/bin/env node
// A mock OMEP 1.0 streaming engine (stream.jam, omep/lib/stream.mjs): a plucked pattern that follows the
// chords, on the studio's beat — a pluck starts exactly on every beat (and every eighth when the intensity
// is above 0.5), so a test can measure where the stream sounds against the transport.
//   --latency <ms>  every message leaves this late (a slow network or a slow model)
//   --jitter <ms>   plus up to this much, at random (messages overtake each other)
//   --seed <n>      the jitter's random sequence
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EXTENSION } from './lib/schemas.mjs';
import { parseChord } from './lib/music.mjs';
import { createStreamHost } from './lib/stream-server.mjs';
import { SAMPLE_RATE, STREAM_PROTOCOL, FRAME_SAMPLES } from './lib/stream.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const LATENCY = arg('--latency', 0);
const JITTER = arg('--jitter', 0);
let seed = arg('--seed', 1);
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const LICENSE = { code: 'MIT', weights: null, commercial: 'yes', attribution: null, conditions: null, url: 'https://github.com/iltempe/openband/blob/main/LICENSE' };
export const MANIFEST = {
  omep: '1.0',
  engine: { id: 'omep-mock-stream', name: 'OMEP mock streaming engine', version: '1.0.0', homepage: 'https://github.com/iltempe/openband/tree/main/omep' },
  license: LICENSE,
  runtime: { where: 'local', device: ['cpu'], realtime: true },
  capabilities: { 'stream.jam': { conditioning: ['bpm', 'chords', 'text'] } },
  outputs: ['application/x-omep-stream'],
  languages: ['en', 'it'],
  determinism: 'seeded',
};

const BEATS_PER_BAR = 4;
const C_MAJOR = { root: 0, tones: [0, 4, 7] };
const chordOf = (control, bar) => {
  const list = control.chords?.length ? control.chords : null;
  return (list && parseChord(list[((bar % list.length) + list.length) % list.length])) || C_MAJOR;
};

/** The frames, as a pure function of the beat: a pluck on every beat (the downbeat an octave lower, louder). */
function render({ beat, frames, bpm, control }) {
  const out = new Float32Array(frames * 2);
  const bps = bpm / 60;
  const sub = (control.intensity ?? 0.5) > 0.5 ? 0.5 : 1;
  const level = 0.5 + (control.intensity ?? 0.5) / 2;
  const decayBeats = 0.45 * bps; // 0.45 s of tail
  for (let i = 0; i < frames; i++) {
    const b = beat + (i / SAMPLE_RATE) * bps;
    let v = 0;
    for (let k = Math.ceil((b - decayBeats) / sub) * sub; k <= b + 1e-9; k += sub) {
      const t = (b - k) / bps;
      const kb = Math.round(k / sub) * sub;
      const bar = Math.floor(kb / BEATS_PER_BAR);
      const pos = kb - bar * BEATS_PER_BAR;
      const c = chordOf(control, bar);
      const down = Math.abs(pos) < 1e-6;
      const pitch = down ? 36 + c.root : 60 + c.tones[Math.round(pos / sub) % c.tones.length];
      const f = 440 * 2 ** ((pitch - 69) / 12);
      const amp = (down ? 0.55 : 0.32) * level;
      v += amp * Math.exp(-t * 14) * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t));
    }
    out[i * 2] = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

const host = await createStreamHost({ render, delay: LATENCY || JITTER ? () => LATENCY + random() * JITTER : null });

const server = new McpServer({ name: 'omep-mock-stream', version: MANIFEST.engine.version }, { capabilities: { experimental: { [EXTENSION]: { version: '1.0' } } } });
server.registerResource('manifest', 'omep://manifest', { title: 'OMEP manifest', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(MANIFEST, null, 2) }] }));

server.registerTool(
  'stream.jam',
  {
    title: 'stream.jam',
    description: 'OMEP stream.jam (mock): open a real-time stream (request.action "open", with style, chords, intensity) or close one ("close", with session)',
    inputSchema: {
      context: z.union([z.looseObject({}), z.string()]).describe('Song Context Package'),
      request: z.looseObject({}).optional(),
      seed: z.number().int().optional(),
    },
  },
  async ({ context, request = {} }) => {
    const contribution = (stream, claims = {}) => ({ kind: 'stream', stream, claims, provenance: { engine: MANIFEST.engine.id, engine_version: MANIFEST.engine.version, model_hash: 'none', capability: 'stream.jam' }, license: LICENSE });
    if (request.action === 'close') {
      const closed = host.close(String(request.session ?? ''));
      return { content: [{ type: 'text', text: closed ? 'closed' : 'no such session' }], structuredContent: contribution({ transport: 'ws-pcm', url: '', session: String(request.session ?? ''), closed }) };
    }
    const scp = typeof context === 'object' ? context : {};
    // Chords: what the studio asks for, or the song's harmony, one per bar from the scope.
    const harmony = (scp.harmony ?? []).filter((h) => h.beat === 0 || h.beat === undefined).sort((a, b) => a.bar - b.bar);
    const chords = request.chords ?? (harmony.length ? harmony.map((h) => h.chord) : undefined);
    const { session, url } = host.open({ style: request.style, chords, intensity: request.intensity });
    const stream = { transport: 'ws-pcm', url, protocol: STREAM_PROTOCOL, session, sample_rate: SAMPLE_RATE, channels: 2, frame_samples: FRAME_SAMPLES };
    return {
      content: [{ type: 'text', text: `stream open: ${url}` }],
      structuredContent: contribution(stream, scp.song?.bpm ? { bpm: scp.song.bpm } : {}),
    };
  },
);

await server.connect(new StdioServerTransport());
