#!/usr/bin/env node
// omep-comfyui: the user's ComfyUI workflows as an OMEP engine (lib/comfyui.mjs has the mapping).
//   --mapping <file>   which workflow plays which capability, and where the song goes
//   --url <url>        ComfyUI (default http://127.0.0.1:8188)
// In ~/.openband/engines.json: "comfy": { "builtin": "omep-comfyui", "mapping": "~/comfy/omep.json" }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { EXTENSION } from './lib/schemas.mjs';
import { scopeTimes } from './lib/acestep.mjs';
import { ComfyClient, audioOutputs, conditioningOf, fillWorkflow, readMapping } from './lib/comfyui.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MAPPING = arg('--mapping');
const URL_ = arg('--url') ?? process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';
if (!MAPPING) {
  console.error('omep-comfyui needs --mapping <file> ("mapping" in engines.json)');
  process.exit(2);
}
const mapping = readMapping(MAPPING);
const comfy = new ComfyClient({ base: URL_ });
const host = new URL(URL_).hostname;
const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

// The licence is the models': only the user knows which ones the workflows load, so they declare it.
const LICENSE = mapping.license ?? { code: 'GPL-3.0', weights: null, commercial: 'conditional', attribution: null, conditions: 'Declare the licence of the models your workflows use ("license" in the mapping file)', url: 'https://github.com/comfyanonymous/ComfyUI' };
export const MANIFEST = {
  omep: '1.0',
  engine: { id: 'omep-comfyui', name: `${mapping.name} (ComfyUI)`, version: '1.0.0', homepage: 'https://github.com/iltempe/openband/tree/main/omep' },
  license: LICENSE,
  runtime: { where: loopback ? 'local' : 'lan', device: ['cuda', 'mps', 'cpu'], realtime: false },
  capabilities: Object.fromEntries(Object.entries(mapping.capabilities).map(([cap, c]) => [cap, { conditioning: conditioningOf(c.inputs) }])),
  outputs: ['audio/wav', 'audio/flac', 'audio/mpeg', 'audio/ogg'],
  languages: ['en'],
  determinism: Object.values(mapping.capabilities).every((c) => Object.values(c.inputs).includes('seed')) ? 'seeded' : 'stochastic',
};

async function songAudio(uri) {
  if (uri.startsWith('data:')) return Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
  if (uri.startsWith('file:')) return fs.readFileSync(fileURLToPath(uri));
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Could not read the song's audio (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function perform(capability, args, signal) {
  const cap = mapping.capabilities[capability];
  const scp = args.context;
  const request = args.request ?? {};
  const seed = args.seed ?? 1;
  const needsAudio = Object.values(cap.inputs).includes('context_audio.mix');
  let uploaded = null;
  if (needsAudio) {
    const mix = scp.context_audio?.mix_uri;
    if (!mix) throw new Error(`${capability} needs the song's audio (context_audio)`);
    uploaded = await comfy.upload(await songAudio(mix), `openband-${process.pid}-${Date.now().toString(36)}.wav`);
  }
  const workflow = fillWorkflow(cap, scp, request, seed, uploaded);
  const id = await comfy.queue(workflow);
  const history = await comfy.wait(id, { signal, pollMs: Number(process.env.OMEP_COMFYUI_POLL_MS) || 1000 });
  const outs = audioOutputs(history, cap.output);
  if (!outs.length) throw new Error(`The workflow finished without audio${cap.output ? ` at node ${cap.output}` : ''} (end it with a Save Audio node)`);
  const files = [];
  for (const o of outs.slice(0, 4)) {
    const bytes = await comfy.view(o);
    const file = path.join(os.tmpdir(), `omep-comfyui-${process.pid}-${Date.now().toString(36)}-${files.length}.${o.format === 'ogg' ? 'ogg' : o.format}`);
    fs.writeFileSync(file, bytes);
    files.push({ uri: pathToFileURL(file).href, role: cap.role, format: o.format });
  }
  const s = scopeTimes(scp);
  return {
    kind: 'audio',
    files,
    alignment: { start_bar: scp.scope?.from_bar ?? 1 },
    claims: { ...(scp.song?.bpm && Object.values(cap.inputs).some((v) => String(v).includes('song.bpm')) ? { bpm: scp.song.bpm } : {}), ...(scp.song?.key && Object.values(cap.inputs).some((v) => String(v).includes('song.key')) ? { key: scp.song.key } : {}), length_bars: s.bars },
    provenance: { engine: MANIFEST.engine.id, engine_version: MANIFEST.engine.version, model_hash: 'none', seed, capability, prompt: `${path.basename(cap.file)} (prompt ${id})` },
    license: LICENSE,
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
    { title: capability, description: `${mapping.name}: OMEP ${capability} through the ComfyUI workflow ${path.basename(mapping.capabilities[capability].file)}`, inputSchema: inputShape, execution: { taskSupport: 'optional' } },
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
            await store.storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: `${capability}: ComfyUI made ${c.files.length} file(s)` }], structuredContent: c });
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
