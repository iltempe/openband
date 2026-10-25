#!/usr/bin/env node
// A model on fal.ai as an OMEP 1.0 engine (SPEC v0.6 §9-bis): node omep/fal-engine.mjs --model ace-step
// The model comes from omep/fal-catalog.json; the key from FAL_KEY in the engine's environment (set in
// ~/.openband/engines.json — never in the song, never in the browser). FAL_QUEUE_URL points it at a
// relay or a test server instead of fal. Every capability is an MCP task (optional): fal's queue is
// followed while it runs, and cancelling the task cancels the request at fal.
//
//   { "engines": { "fal-ace-step": { "builtin": "omep-fal", "model": "ace-step", "env": { "FAL_KEY": "…" } } } }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { EXTENSION } from './lib/schemas.mjs';
import { FAL_QUEUE, FalQueue, inputFor, manifestFor, outputsOf, quote, scopeSeconds } from './lib/fal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(process.env.OMEP_FAL_CATALOG || path.join(here, 'fal-catalog.json'), 'utf8'));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith(`${name}=`))?.split('=')[1];
};
const model = catalog.models.find((m) => m.id === (arg('--model') ?? process.env.OMEP_FAL_MODEL));
if (!model) {
  console.error(`omep-fal: give --model, one of ${catalog.models.map((m) => m.id).join(', ')}`);
  process.exit(2);
}
export const MANIFEST = manifestFor(model, catalog.verified);
const key = process.env.FAL_KEY || process.env.OPENBAND_FAL_KEY || null;
const queue = new FalQueue({ base: process.env.FAL_QUEUE_URL || FAL_QUEUE, key, token: process.env.FAL_RELAY_TOKEN || null });

/** Seconds of a WAV file (from its header), or null. */
function wavSeconds(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF') return null;
  let at = 12;
  let rate = 0;
  let block = 0;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      rate = b.readUInt32LE(at + 12);
      block = b.readUInt16LE(at + 20);
    }
    if (id === 'data' && rate && block) return Math.min(size, b.length - at - 8) / (rate * block);
    at += 8 + size + (size % 2);
  }
  return null;
}

const FORMAT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'ogg' };

/** One run at fal: the contribution (files downloaded here, handed to the host as file:// URIs). */
async function perform(capability, args, signal, onStatus) {
  if (!key && queue.base === FAL_QUEUE) throw new Error('No fal key: set FAL_KEY for this engine in ~/.openband/engines.json');
  const scp = args.context;
  const request = args.request ?? {};
  const seed = args.seed ?? 1;
  const input = inputFor(model, scp, request, seed);
  const answer = await queue.run(model.endpoint, input, { signal, onStatus, pollMs: Number(process.env.FAL_POLL_MS) || 1000 });
  const outs = outputsOf(model, answer);
  if (!outs.length) throw new Error(`${model.name} answered without audio`);
  const files = [];
  let seconds = 0;
  for (const o of outs) {
    const res = await fetch(o.url);
    if (!res.ok) throw new Error(`Downloading ${o.role} from fal: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = (res.headers.get('content-type') ?? '').split(';')[0];
    const format = FORMAT[mime] ?? (/\.(wav|mp3|flac|ogg)(\?|$)/.exec(o.url)?.[1] ?? 'wav');
    const file = path.join(os.tmpdir(), `omep-fal-${model.id}-${process.pid}-${Date.now().toString(36)}-${o.role}.${format}`);
    fs.writeFileSync(file, bytes);
    if (format === 'wav') seconds = Math.max(seconds, wavSeconds(bytes) ?? 0);
    // OMEP roles: the whole song, or a layer over the song; stems keep theirs (vocal, drums, bass, other).
    const role = o.role === 'audio' ? (capability === 'music.song' ? 'full' : 'layer') : o.role;
    files.push({ uri: pathToFileURL(file).href, role, format });
  }
  // What it cost, from what came back (separation: the input's length).
  const billed = model.price.unit === 'second' ? (capability === 'audio.separate' ? Number(request.seconds) || scopeSeconds(scp) : seconds || input.duration || scopeSeconds(scp)) : 1;
  const cost = Math.round((model.price.unit === 'second' ? billed * model.price.usd : model.price.usd) * 1e6) / 1e6;
  const from = scp.scope?.from_bar ?? 1;
  const bars = (scp.scope?.to_bar ?? from + (scp.song?.length_bars ?? 8)) - from;
  return {
    kind: capability === 'audio.separate' ? 'stems' : 'audio',
    files,
    alignment: { start_bar: from },
    claims: capability === 'audio.separate' ? {} : { bpm: scp.song?.bpm, key: scp.song?.key, length_bars: bars },
    provenance: { engine: MANIFEST.engine.id, engine_version: `${MANIFEST.engine.version} (${model.endpoint})`, model_hash: 'none', seed, capability, prompt: input.tags ?? input.prompt ?? undefined },
    license: model.license,
    cost_usd: cost,
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

for (const capability of Object.keys(model.capabilities)) {
  server.experimental.tasks.registerToolTask(
    capability,
    { title: capability, description: `${model.name}: OMEP ${capability} (about ${model.price.usd} USD per ${model.price.unit})`, inputSchema: inputShape, execution: { taskSupport: 'optional' } },
    {
      async createTask(args, { taskStore: store, taskRequestedTtl }) {
        const task = await store.createTask({ ttl: taskRequestedTtl ?? 30 * 60_000, pollInterval: 250 });
        const abort = new AbortController();
        // Cancelling the task cancels the request at fal.
        const watch = setInterval(async () => {
          const t = await store.getTask(task.taskId).catch(() => null);
          if (!t || t.status === 'cancelled') abort.abort();
        }, 200);
        (async () => {
          try {
            const c = await perform(capability, args, abort.signal);
            await store.storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: `${capability}: ${c.files.length} file(s) from ${model.name}, ${c.cost_usd} USD` }], structuredContent: c });
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

/** The price before running: tools/call quote, for routers that want it from the engine itself. */
server.registerTool('quote', { title: 'Quote', description: 'What a run would cost (USD), before running it.', inputSchema: { capability: z.string(), context: z.looseObject({}), request: z.looseObject({}).optional() }, annotations: { readOnlyHint: true } }, async ({ context, request }) => {
  const usd = quote(model, context, request ?? {});
  return { content: [{ type: 'text', text: `${usd} USD` }], structuredContent: { usd, unit: model.price.unit, price_usd: model.price.usd } };
});

await server.connect(new StdioServerTransport());
