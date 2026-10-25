#!/usr/bin/env node
// ACE-Step 1.5 on your computer as an OMEP 1.0 engine (SPEC v0.6 §10): node omep/ace-step-engine.mjs
// It talks to the REST server ACE-Step ships, which you start yourself — OpenBand doesn't install
// Python or download weights for you:
//
//   git clone https://github.com/ACE-Step/ACE-Step-1.5 && cd ACE-Step-1.5 && uv sync && uv run acestep-api
//   { "engines": { "ace-step": { "builtin": "omep-ace-step" } } }               (in ~/.openband/engines.json)
//
// ACESTEP_API_URL (default http://127.0.0.1:8001), ACESTEP_API_KEY when the server has one, and
// ACESTEP_MODEL: the model the server runs (acestep-v15-turbo by default; adding a layer — ACE-Step's
// "lego" — needs a base model, e.g. acestep-v15-base). Every capability is an MCP task (optional).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { EXTENSION } from './lib/schemas.mjs';
import { ACESTEP_API, AceStepApi, manifestFor, scopeTimes, taskFor, trimWav } from './lib/acestep.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith(`${name}=`))?.split('=')[1];
};
const MODEL = arg('--model') ?? process.env.ACESTEP_MODEL ?? 'acestep-v15-turbo';
export const MANIFEST = manifestFor(MODEL);
const api = new AceStepApi({ base: arg('--url') ?? process.env.ACESTEP_API_URL ?? ACESTEP_API, key: process.env.ACESTEP_API_KEY || null });

/** The context audio's bytes: a data: URI, a file:// path, or http(s). */
async function contextAudio(uri) {
  if (uri.startsWith('data:')) return Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
  if (uri.startsWith('file:')) return fs.readFileSync(fileURLToPath(uri));
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Could not read the song's audio (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function perform(capability, args, signal) {
  const scp = args.context;
  const request = args.request ?? {};
  const seed = args.seed ?? 1;
  const spb = (Number(String(scp.song?.meter ?? '4/4').split('/')[0]) * 60) / (scp.song?.bpm || 120);
  const ca = scp.context_audio;
  const needs = capability !== 'music.song';
  if (needs && !ca?.mix_uri) throw new Error(`${capability} needs the song's audio (context_audio) — OpenBand sends it when the manifest asks`);
  const ctx = needs ? { start: ((ca.from_bar ?? scp.scope?.from_bar ?? 1) - 1) * spb } : null;
  const fields = taskFor(capability, scp, request, seed, ctx);
  let answer;
  try {
    answer = await api.run(fields, needs ? await contextAudio(ca.mix_uri) : null, { signal, pollMs: Number(process.env.ACESTEP_POLL_MS) || 1000 });
  } catch (e) {
    if (/fetch failed|ECONNREFUSED/.test(String(e.cause?.code ?? e.message))) throw new Error(`ACE-Step isn't running at ${api.base}: start it with \`uv run acestep-api\` in its folder`);
    throw e;
  }
  // The scope only: repaint answers the whole context, lego and cover its length.
  const s = scopeTimes(scp);
  const bytes = ctx ? trimWav(answer.bytes, Math.max(0, s.start - ctx.start), s.seconds) : answer.bytes;
  const file = path.join(os.tmpdir(), `omep-ace-step-${process.pid}-${Date.now().toString(36)}.wav`);
  fs.writeFileSync(file, bytes);
  return {
    kind: 'audio',
    files: [{ uri: pathToFileURL(file).href, role: capability === 'music.song' ? 'full' : 'layer', format: 'wav' }],
    alignment: { start_bar: scp.scope?.from_bar ?? 1 },
    claims: { bpm: scp.song?.bpm, key: scp.song?.key, length_bars: s.bars },
    provenance: { engine: MANIFEST.engine.id, engine_version: `${MANIFEST.engine.version} (${MODEL})`, model_hash: 'none', seed: answer.seed ?? seed, capability, prompt: fields.prompt || fields.instruction },
    license: MANIFEST.license,
  };
}

const taskStore = new InMemoryTaskStore();
const server = new McpServer({ name: MANIFEST.engine.id, version: MANIFEST.engine.version }, { capabilities: { experimental: { [EXTENSION]: { version: '1.0' } }, tasks: { requests: { tools: { call: {} } } } }, taskStore });
server.registerResource('manifest', 'omep://manifest', { title: 'OMEP manifest', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(MANIFEST, null, 2) }] }));

const inputShape = {
  context: z.looseObject({}).describe('Song Context Package'),
  request: z.looseObject({}).optional(),
  seed: z.number().int().optional(),
  variants: z.number().int().min(1).max(8).optional(),
};

for (const capability of Object.keys(MANIFEST.capabilities)) {
  server.experimental.tasks.registerToolTask(
    capability,
    { title: capability, description: `ACE-Step 1.5 (${MODEL}) on this computer: OMEP ${capability}`, inputSchema: inputShape, execution: { taskSupport: 'optional' } },
    {
      async createTask(args, { taskStore: store, taskRequestedTtl }) {
        const task = await store.createTask({ ttl: taskRequestedTtl ?? 30 * 60_000, pollInterval: 250 });
        const abort = new AbortController();
        const watch = setInterval(async () => {
          const t = await store.getTask(task.taskId).catch(() => null);
          if (!t || t.status === 'cancelled') abort.abort();
        }, 200);
        (async () => {
          try {
            const c = await perform(capability, args, abort.signal);
            await store.storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: `${capability}: ACE-Step made ${c.claims.length_bars} bars` }], structuredContent: c });
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
}

await server.connect(new StdioServerTransport());
