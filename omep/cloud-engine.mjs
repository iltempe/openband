#!/usr/bin/env node
// omep-cloud: the music generation gateway (docs/adr/0004-music-gateway.md) — one OMEP engine per provider
// account, a driver per provider (omep/cloud/drivers/). To the studio it is an engine like the local
// ones: routed, budgeted, conformed and in the ledger.
//   --provider stability|elevenlabs|mureka|lyria|local
//   --model <id>        the provider's model (default: the driver's)
//   --plan <name>       the user's plan with the provider, when the rights depend on it (ElevenLabs)
//   --base <url>        another endpoint (a regional one, a test server; "base_url" for local servers)
//   --config <json>     the engines.json entry (local servers declare their requests there)
// The key comes from the environment (STABILITY_API_KEY, ELEVENLABS_API_KEY, MUREKA_API_KEY,
// GEMINI_API_KEY, LOCAL_API_KEY): engines.json "env", on this computer only.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { EXTENSION } from './lib/schemas.mjs';
import { GatewayError, httpClient, limiter, scopeTimes, writeAudio } from './cloud/runtime.mjs';
import { DRIVERS } from './cloud/drivers/index.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const config = arg('--config') ? JSON.parse(arg('--config')) : {};
const providerId = arg('--provider') ?? config.provider;
const driver = DRIVERS[providerId];
if (!driver) {
  console.error(`omep-cloud: unknown provider "${providerId}" (one of ${Object.keys(DRIVERS).join(', ')})`);
  process.exit(2);
}
const models = driver.modelsFor ? driver.modelsFor(config) : driver.models;
const modelId = arg('--model') ?? config.model ?? driver.defaultModel;
const model = models[modelId];
if (!model) {
  console.error(`omep-cloud: ${driver.name} has no model "${modelId}" (one of ${Object.keys(models).join(', ')})`);
  process.exit(2);
}
const plan = arg('--plan') ?? config.plan;
const base = arg('--base') ?? config.base_url ?? driver.base;
if (!base) {
  console.error(`omep-cloud: ${driver.name} needs "base_url"`);
  process.exit(2);
}
const host = new URL(base).hostname;
const onThisComputer = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
const isLocal = driver.id === 'local';
const rights = driver.rights(plan, config);

export const MANIFEST = {
  omep: '1.0',
  engine: { id: isLocal ? `omep-local-${String(config.name ?? 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : `omep-cloud-${driver.id}`, name: isLocal ? model.name : `${model.name} (${driver.name})`, version: '1.0.0', homepage: driver.homepage },
  license: rights.license,
  runtime: isLocal
    ? { where: onThisComputer ? 'local' : 'lan', device: ['cpu', 'cuda', 'mps'], realtime: false }
    : {
        where: 'cloud',
        provider: driver.name,
        realtime: false,
        // A price the provider doesn't publish is an estimate: not marked as verified.
        pricing: { unit: model.pricing.unit, usd: model.pricing.usd, ...(model.pricing.estimated ? {} : { verified: model.pricing.verified }) },
        data_policy: driver.data_policy,
        output_rights: rights.output_rights,
      },
  capabilities: model.capabilities,
  outputs: ['audio/wav', 'audio/mpeg', 'audio/flac'],
  languages: ['en', 'it'],
  determinism: driver.id === 'stability' ? 'seeded' : 'stochastic',
};

const key = process.env[driver.keyEnv] ?? '';
const limit = limiter(driver.concurrency ?? 2);

async function perform(capability, args, signal, progress) {
  if (!key && !isLocal) throw new GatewayError('auth', driver.name, `No ${driver.name} key: add it in OpenBand (Ensemble → Music services) — it stays on this computer`);
  const http = httpClient({ provider: driver.name, base, headers: driver.auth(key, config), parseError: driver.parseError?.bind(driver), limit, signal, hosts: isLocal ? [new URL(base).host] : [...new Set([...driver.hosts, new URL(base).host])] });
  const scp = args.context;
  const r = await driver.run({ capability, model: modelId, scp, request: args.request ?? {}, seed: args.seed, http, signal, progress, config, plan });
  const files = [];
  for (const f of r.files) {
    const w = await writeAudio(f.bytes, `omep-${driver.id}`);
    files.push({ uri: w.uri, role: f.role, format: w.format });
  }
  const s = scopeTimes(scp);
  const conditioned = model.capabilities[capability]?.conditioning ?? [];
  return {
    kind: 'audio',
    files,
    alignment: { start_bar: scp.scope?.from_bar ?? 1, ...(r.alignment ?? {}) },
    claims: { length_bars: s.bars, ...(scp.song?.bpm && conditioned.includes('bpm') ? { bpm: scp.song.bpm } : {}), ...(scp.song?.key && conditioned.includes('key') ? { key: scp.song.key } : {}) },
    provenance: { engine: MANIFEST.engine.id, engine_version: `${MANIFEST.engine.version} (${modelId})`, model_hash: 'none', capability, ...(Number.isInteger(r.provenance?.seed ?? args.seed) ? { seed: r.provenance?.seed ?? args.seed } : {}), ...(r.provenance?.prompt ? { prompt: String(r.provenance.prompt).slice(0, 4000) } : {}), ...(r.provenance?.request_id ? { request_id: String(r.provenance.request_id) } : {}) },
    license: rights.license,
    ...(Number.isFinite(r.cost_usd) ? { cost_usd: r.cost_usd } : {}),
  };
}

/** An error as the studio shows it: what happened, and what to do. */
const failure = (e) => `${e.message}${e.suggestion ? ` — try: “${e.suggestion}”` : ''}${e.requestId ? ` (request ${e.requestId})` : ''}`;

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
    { title: capability, description: `${MANIFEST.engine.name}: OMEP ${capability}`, inputSchema: inputShape, execution: { taskSupport: 'optional' } },
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
            const c = await perform(capability, args, abort.signal);
            await store.storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: `${capability}: ${MANIFEST.engine.name} made ${c.files.length} file(s)` }], structuredContent: c });
          } catch (e) {
            if (!abort.signal.aborted) await store.storeTaskResult(task.taskId, 'failed', { content: [{ type: 'text', text: failure(e) }], isError: true }).catch(() => {});
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
