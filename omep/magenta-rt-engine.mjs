#!/usr/bin/env node
// omep-magenta-rt: Magenta RealTime 2 (Google, code Apache-2.0, weights CC BY 4.0) as an OMEP streaming
// engine (stream.jam). The model runs in the user's own Python, where they installed it:
//
//   uv pip install "magenta-rt[mlx]"   (Apple Silicon)   ·   uv pip install magenta-rt "jax[cuda13]"   (NVIDIA)
//   mrt models init && mrt models download mrt2_small
//
// That Python runs omep/magenta_rt_worker.py, which this file talks to over stdio (one 40 ms frame per
// request, as MRT2 makes them). MRT2 has no tempo input: the studio's beat reaches it as conditioning —
// a drum onset on every beat (eighths at high intensity) and the chords as a piano roll with onsets on
// each bar — so it plays along; the stream itself is always exactly on the beat it carries.
//   --python <path>   the Python with magenta-rt (default python3)
//   --model <name>    mrt2_small (default; real time on any Apple Silicon) or mrt2_base
//   --backend <b>     mlx (default on Apple Silicon) or jax
//   --worker <json>   another command speaking the worker protocol, as a JSON argv (tests)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EXTENSION } from './lib/schemas.mjs';
import { conditioningFor } from './lib/mrt.mjs';
import { createStreamHost } from './lib/stream-server.mjs';
import { FRAME_SAMPLES, SAMPLE_RATE, STREAM_PROTOCOL } from './lib/stream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const MODEL = opt('--model', 'mrt2_small');
const BACKEND = opt('--backend', process.platform === 'darwin' && process.arch === 'arm64' ? 'mlx' : 'jax');
const WORKER = opt('--worker') ? JSON.parse(opt('--worker')) : [opt('--python', 'python3'), path.join(here, 'magenta_rt_worker.py'), '--model', MODEL, '--backend', BACKEND];

const LICENSE = {
  code: 'Apache-2.0',
  weights: 'CC-BY-4.0',
  commercial: 'yes',
  attribution: 'Magenta RealTime 2 by Google (weights CC BY 4.0)',
  conditions: null,
  url: 'https://huggingface.co/google/magenta-realtime-2',
};
export const MANIFEST = {
  omep: '1.0',
  engine: { id: 'omep-magenta-rt', name: `Magenta RealTime 2 (${MODEL})`, version: '2.0.3', homepage: 'https://github.com/magenta/magenta-realtime' },
  license: LICENSE,
  runtime: { where: 'local', device: BACKEND === 'mlx' ? ['mps'] : ['cuda', 'cpu'], realtime: true },
  capabilities: { 'stream.jam': { conditioning: ['bpm', 'chords', 'text'] } },
  outputs: ['application/x-omep-stream'],
  languages: ['en'],
  determinism: 'stochastic',
};

/**
 * The worker: started on the first stream, kept while the engine lives (loading the model takes seconds).
 * Messages from it: u32 length · u8 kind (0 JSON, 1 audio: u32 id + float32 stereo interleaved) · payload.
 */
class Worker {
  constructor(argv) {
    this.argv = argv;
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.buf = Buffer.alloc(0);
    this.style = undefined;
    this.stderr = '';
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((ok, fail) => {
      const p = spawn(this.argv[0], this.argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = p;
      this.onJson = (m) => {
        if (m.ready) ok(m);
        if (m.error && !m.id) fail(new Error(`Magenta RealTime: ${m.error}`));
        if (m.id && this.pending.has(m.id)) {
          const w = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) w.fail(new Error(m.error));
          else w.ok(null);
        }
      };
      p.stdout.on('data', (d) => this.read(d));
      p.stderr.on('data', (d) => (this.stderr = (this.stderr + d).slice(-2000)));
      p.on('error', (e) => fail(new Error(`Could not start ${this.argv[0]}: ${e.message} (set "python" in engines.json to the Python where magenta-rt is installed)`)));
      p.on('exit', (code) => {
        const why = new Error(`The Magenta RealTime worker stopped (${code}): ${this.stderr.trim().split('\n').slice(-3).join(' ') || 'no output'}`);
        fail(why);
        for (const w of this.pending.values()) w.fail(why);
        this.pending.clear();
        this.ready = null;
        this.style = undefined;
      });
    });
    return this.ready;
  }

  read(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      const kind = this.buf[4];
      const body = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      if (kind === 0) this.onJson(JSON.parse(body.toString('utf8')));
      else if (kind === 1) {
        const id = body.readUInt32LE(0);
        const w = this.pending.get(id);
        if (!w) continue;
        this.pending.delete(id);
        const pcm = body.subarray(4);
        const copy = new Float32Array(pcm.length / 4);
        for (let i = 0; i < copy.length; i++) copy[i] = pcm.readFloatLE(i * 4);
        w.ok(copy);
      }
    }
  }

  request(msg) {
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.proc.stdin.write(`${JSON.stringify({ ...msg, id })}\n`);
    });
  }

  async setStyle(text) {
    if (text === this.style) return;
    this.style = text;
    await this.request({ op: 'style', text });
  }
}

const worker = new Worker(WORKER);

async function render({ beat, frames, bpm, control }) {
  await worker.start();
  await worker.setStyle(control.style ?? '');
  const cond = conditioningFor(beat, frames, bpm, control);
  const gain = 0.6 + 0.6 * (control.intensity ?? 0.5);
  const out = await worker.request({ op: 'gen', frames: [cond] });
  if (out.length !== frames * 2) throw new Error(`Magenta RealTime gave ${out.length / 2} samples for a ${frames}-sample frame`);
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

const host = await createStreamHost({ render });

const server = new McpServer({ name: 'omep-magenta-rt', version: MANIFEST.engine.version }, { capabilities: { experimental: { [EXTENSION]: { version: '1.0' } } } });
server.registerResource('manifest', 'omep://manifest', { title: 'OMEP manifest', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(MANIFEST, null, 2) }] }));

server.registerTool(
  'stream.jam',
  {
    title: 'stream.jam',
    description: 'Magenta RealTime 2: open a real-time stream (request.action "open", with style, chords, intensity) or close one ("close", with session)',
    inputSchema: {
      context: z.union([z.looseObject({}), z.string()]).describe('Song Context Package'),
      request: z.looseObject({}).optional(),
      seed: z.number().int().optional(),
    },
  },
  async ({ context, request = {} }) => {
    const contribution = (stream, claims = {}) => ({ kind: 'stream', stream, claims, provenance: { engine: MANIFEST.engine.id, engine_version: MANIFEST.engine.version, model_hash: 'none', capability: 'stream.jam', ...(request.style ? { prompt: String(request.style) } : {}) }, license: LICENSE });
    if (request.action === 'close') {
      const closed = host.close(String(request.session ?? ''));
      return { content: [{ type: 'text', text: closed ? 'closed' : 'no such session' }], structuredContent: contribution({ transport: 'ws-pcm', url: '', session: String(request.session ?? ''), closed }) };
    }
    try {
      await worker.start(); // the model loads now, not on the first frame
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
    const scp = typeof context === 'object' ? context : {};
    const harmony = (scp.harmony ?? []).filter((h) => !h.beat).sort((a, b) => a.bar - b.bar);
    const chords = request.chords ?? (harmony.length ? harmony.map((h) => h.chord) : undefined);
    const { session, url } = host.open({ style: request.style, chords, intensity: request.intensity });
    const stream = { transport: 'ws-pcm', url, protocol: STREAM_PROTOCOL, session, sample_rate: SAMPLE_RATE, channels: 2, frame_samples: FRAME_SAMPLES };
    return { content: [{ type: 'text', text: `stream open: ${url}` }], structuredContent: contribution(stream, scp.song?.bpm ? { bpm: scp.song.bpm } : {}) };
  },
);

await server.connect(new StdioServerTransport());
