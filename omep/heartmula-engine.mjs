#!/usr/bin/env node
// omep-heartmula: HeartMuLa (heartlib) on this computer as an OMEP engine (lib/heartmula.mjs).
//   --repo <clone of github.com/HeartMuLa/heartlib>  --python <its Python>  [--model-path <ckpt>] [--version 3B] [--lazy-load]
// music.song only: heartlib has no reference-audio mode yet (MuLaCover, its cover model, is non-commercial),
// and HeartTranscriptor's lyrics without timings don't fit OMEP 1.0's audio.transcribe (notes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { EXTENSION } from './lib/schemas.mjs';
import { scopeTimes } from './lib/acestep.mjs';
import { HEARTMULA_LICENSE, runHeartMuLa } from './lib/heartmula.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const home = (p) => (p ? p.replace(/^~(?=\/|$)/, os.homedir()) : p);
const OPTS = {
  repo: home(arg('--repo') ?? process.env.HEARTMULA_REPO ?? ''),
  python: home(arg('--python') ?? process.env.HEARTMULA_PYTHON ?? 'python'),
  modelPath: home(arg('--model-path')),
  version: arg('--version') ?? '3B',
  lazyLoad: process.argv.includes('--lazy-load'),
};

export const MANIFEST = {
  omep: '1.0',
  engine: { id: 'omep-heartmula', name: `HeartMuLa ${OPTS.version}`, version: '1.0.0', homepage: 'https://github.com/HeartMuLa/heartlib' },
  license: HEARTMULA_LICENSE,
  runtime: { where: 'local', device: ['cuda'], realtime: false },
  capabilities: { 'music.song': { conditioning: ['lyrics', 'text', 'sections', 'bpm', 'key'], max_seconds: 240 } },
  outputs: ['audio/wav'],
  languages: ['en', 'zh', 'ja', 'ko', 'es'],
  determinism: 'stochastic',
};

async function perform(args, signal) {
  if (!OPTS.repo || !fs.existsSync(path.join(OPTS.repo, 'examples', 'run_music_generation.py'))) {
    throw new Error(`HeartMuLa is not set up: "repo" in engines.json must be your clone of github.com/HeartMuLa/heartlib (with examples/run_music_generation.py)${OPTS.repo ? ` — not found in ${OPTS.repo}` : ''}, and "python" its Python`);
  }
  const scp = args.context;
  const r = await runHeartMuLa({ ...OPTS, scp, request: args.request ?? {}, signal });
  const file = path.join(r.dir, 'song.wav');
  const s = scopeTimes(scp);
  return {
    kind: 'audio',
    files: [{ uri: pathToFileURL(file).href, role: 'full', format: 'wav', sample_rate: 48000 }],
    alignment: { start_bar: scp.scope?.from_bar ?? 1 },
    claims: { length_bars: s.bars },
    provenance: { engine: MANIFEST.engine.id, engine_version: `${MANIFEST.engine.version} (HeartMuLa-oss-${OPTS.version})`, model_hash: 'none', capability: 'music.song', prompt: r.tags },
    license: HEARTMULA_LICENSE,
  };
}

const taskStore = new InMemoryTaskStore();
const server = new McpServer({ name: MANIFEST.engine.id, version: MANIFEST.engine.version }, { capabilities: { experimental: { [EXTENSION]: { version: '1.0' } }, tasks: { requests: { tools: { call: {} } } } }, taskStore });
server.registerResource('manifest', 'omep://manifest', { title: 'OMEP manifest', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(MANIFEST, null, 2) }] }));

server.experimental.tasks.registerToolTask(
  'music.song',
  {
    title: 'music.song',
    description: `HeartMuLa ${OPTS.version} on this computer: a song from lyrics and tags (OMEP music.song)`,
    inputSchema: { context: z.looseObject({}).describe('Song Context Package'), request: z.looseObject({}).optional(), seed: z.number().int().optional(), variants: z.number().int().min(1).max(8).optional() },
    execution: { taskSupport: 'optional' },
  },
  {
    async createTask(args, { taskStore: store, taskRequestedTtl }) {
      const task = await store.createTask({ ttl: taskRequestedTtl ?? 30 * 60_000, pollInterval: 500 });
      const abort = new AbortController();
      const watch = setInterval(async () => {
        const t = await store.getTask(task.taskId).catch(() => null);
        if (!t || t.status === 'cancelled') abort.abort();
      }, 300);
      (async () => {
        try {
          const c = await perform(args, abort.signal);
          await store.storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: `music.song: HeartMuLa made ${c.claims.length_bars} bars` }], structuredContent: c });
        } catch (e) {
          if (!abort.signal.aborted) await store.storeTaskResult(task.taskId, 'failed', { content: [{ type: 'text', text: e.message }], isError: true }).catch(() => {});
        } finally {
          clearInterval(watch);
        }
      })();
      return { task };
    },
    getTask: (_args, { taskId, taskStore: store }) => store.getTask(taskId),
    getTaskResult: (_args, { taskId, taskStore: store }) => store.getTaskResult(taskId),
  },
);

await server.connect(new StdioServerTransport());
