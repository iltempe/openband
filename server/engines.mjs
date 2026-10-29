// The engine host (SPEC v0.6 §9): OpenBand as an MCP *client* of OMEP engines. Engines are what the user
// configured in ~/.openband/engines.json (or OPENBAND_ENGINES) — nothing else is ever started:
//
//   { "engines": {
//       "ace-step":  { "builtin": "omep-ace-step", "model": "acestep-v15-turbo" },
//       "studio-pc": { "url": "https://192.168.1.20:8765/mcp", "token": "…" },
//       "mock":      { "builtin": "omep-mock" },
//       "mrt":       { "builtin": "omep-magenta-rt", "python": "~/mrt/.venv/bin/python", "model": "mrt2_small" },
//       "fal-ace-step": { "builtin": "omep-fal", "model": "ace-step", "env": { "FAL_KEY": "…" } }
//   } }
//
// The page reaches them through the bridge (`engine` messages). Files an engine writes (file://) are read
// here and handed to the page inline, audio only, at most 100 MB each.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { GpuScheduler, gpuNeed } from './scheduler.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultEnginesFile = () => process.env.OPENBAND_ENGINES || path.join(os.homedir(), '.openband', 'engines.json');
const BUILTIN = {
  'omep-mock': () => ({ command: process.execPath, args: [path.join(ROOT, 'omep', 'mock-engine.mjs')] }),
  // A model on fal.ai (omep/fal-catalog.json): "model" picks it; its key stays in this engine's env.
  'omep-fal': (e) => ({ command: process.execPath, args: [path.join(ROOT, 'omep', 'fal-engine.mjs'), '--model', String(e.model ?? '')] }),
  // ACE-Step's own REST server on this computer (or "url"); "model": what it runs (lego needs a base model).
  // DiffSinger and a voicebank the user installed: "repo", "exp", "python", and how the voicebank names phonemes.
  'omep-diffsinger': (e) => ({
    command: process.execPath,
    args: [
      path.join(ROOT, 'omep', 'diffsinger-engine.mjs'),
      ...(e.repo ? ['--repo', String(e.repo).replace(/^~(?=\/|$)/, os.homedir())] : []),
      ...(e.exp ? ['--exp', String(e.exp)] : []),
      ...(e.python ? ['--python', String(e.python).replace(/^~(?=\/|$)/, os.homedir())] : []),
      ...(e.spk ? ['--spk', String(e.spk)] : []),
      ...(e.lang ? ['--lang', String(e.lang)] : []),
      ...(e.lang_prefix ? ['--lang-prefix', String(e.lang_prefix)] : []),
      ...(e.phonemes ? ['--phonemes', JSON.stringify(e.phonemes)] : []),
      ...(e.languages ? ['--languages', JSON.stringify(e.languages)] : []),
      ...(e.voicebank ? ['--voicebank', JSON.stringify(e.voicebank)] : []),
    ],
  }),
  // Streaming (stream.jam): the mock, with a simulated network ("latency_ms", "jitter_ms") for tests and demos.
  'omep-mock-stream': (e) => ({ command: process.execPath, args: [path.join(ROOT, 'omep', 'mock-stream-engine.mjs'), ...(e.latency_ms ? ['--latency', String(Number(e.latency_ms))] : []), ...(e.jitter_ms ? ['--jitter', String(Number(e.jitter_ms))] : [])] }),
  // Magenta RealTime 2 in the user's own Python ("python": the venv where magenta-rt is installed; "model":
  // mrt2_small or mrt2_base; "worker": another command speaking the same protocol, as JSON argv).
  'omep-magenta-rt': (e) => ({
    command: process.execPath,
    args: [
      path.join(ROOT, 'omep', 'magenta-rt-engine.mjs'),
      ...(e.python ? ['--python', String(e.python).replace(/^~(?=\/|$)/, os.homedir())] : []),
      ...(e.model ? ['--model', String(e.model)] : []),
      ...(e.backend ? ['--backend', String(e.backend)] : []),
      ...(e.worker ? ['--worker', JSON.stringify(e.worker)] : []),
    ],
  }),
  'omep-ace-step': (e) => ({ command: process.execPath, args: [path.join(ROOT, 'omep', 'ace-step-engine.mjs'), ...(e.model ? ['--model', String(e.model)] : []), ...(e.url ? ['--url', String(e.url)] : [])] }),
};
const AUDIO = { '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };
const MAX_FILE = 100 * 1024 * 1024;

/** The GPU's VRAM budget from engines.json: "gpu": { "vram_gb": 8 } (or per device { "cuda:0": 24 }). */
export function readGpuBudget(file = defaultEnginesFile()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const g = raw.gpu?.vram_gb;
    return typeof g === 'number' ? g : g && typeof g === 'object' ? g : null;
  } catch {
    return null;
  }
}

export function readEnginesConfig(file = defaultEnginesFile()) {
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const [id, e] of Object.entries(raw.engines ?? {})) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || !e || typeof e !== 'object') continue;
    if (e.builtin && BUILTIN[e.builtin]) out[id] = { ...BUILTIN[e.builtin](e), env: e.env };
    else if (typeof e.command === 'string') out[id] = { command: e.command, args: Array.isArray(e.args) ? e.args.map(String) : [], env: e.env };
    else if (typeof e.url === 'string' && /^https?:\/\//.test(e.url)) out[id] = { url: e.url, token: e.token };
  }
  return out;
}

/** A file an engine produced, inline for the page (data: URI). */
function inline(uri) {
  if (!uri.startsWith('file://')) return uri;
  const file = fileURLToPath(uri);
  const mime = AUDIO[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`The engine returned a file that is not audio: ${path.basename(file)}`);
  const size = fs.statSync(file).size;
  if (size > MAX_FILE) throw new Error(`${path.basename(file)} is larger than 100 MB`);
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

export class EngineHost {
  constructor({ file = defaultEnginesFile(), log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    /** id → { key, client, manifest, tools } */
    this.live = new Map();
    // Engines on this computer that need the GPU take turns (scheduler.mjs); unloading = stopping one.
    this.scheduler = new GpuScheduler({ budgetGb: readGpuBudget(file), unload: (id) => this.drop(id) });
  }

  async connect(id, spec) {
    const key = JSON.stringify(spec);
    const have = this.live.get(id);
    if (have && have.key === key) return have;
    if (have) await have.client.close().catch(() => {});
    const client = new Client({ name: 'openband', version: '1' });
    const transport = spec.url
      ? new StreamableHTTPClientTransport(new URL(spec.url), spec.token ? { requestInit: { headers: { authorization: `Bearer ${spec.token}` } } } : undefined)
      : new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...process.env, ...(spec.env ?? {}) }, stderr: 'ignore' });
    await client.connect(transport);
    const res = await client.readResource({ uri: 'omep://manifest' });
    const manifest = JSON.parse(res.contents[0].text);
    const { tools } = await client.listTools();
    const entry = { key, client, manifest, tools: new Map(tools.map((t) => [t.name, t])) };
    this.live.set(id, entry);
    this.log(`engine ${id}: ${manifest.engine?.name ?? id} (${Object.keys(manifest.capabilities ?? {}).join(', ')})`);
    return entry;
  }

  /** Every configured engine with its manifest, or why it isn't available. */
  async list() {
    let cfg;
    try {
      cfg = readEnginesConfig(this.file);
    } catch (e) {
      return [{ id: 'engines.json', status: 'error', error: `${this.file}: ${e.message}` }];
    }
    for (const id of this.live.keys()) if (!cfg[id]) await this.drop(id);
    return Promise.all(
      Object.entries(cfg).map(async ([id, spec]) => {
        try {
          const e = await this.connect(id, spec);
          return { id, status: 'ready', manifest: e.manifest, ...(gpuNeed(spec, e.manifest) ? { gpu: this.scheduler.stateOf(id) } : {}) };
        } catch (err) {
          await this.drop(id);
          return { id, status: 'error', error: err.message };
        }
      }),
    );
  }

  async call(id, capability, args, { timeoutMs = 600000 } = {}) {
    const spec = readEnginesConfig(this.file)[id];
    if (!spec) throw new Error(`No engine "${id}" in ${this.file}`);
    const e = await this.connect(id, spec);
    const need = gpuNeed(spec, e.manifest);
    if (need) {
      const { priority, ...rest } = args ?? {};
      return this.scheduler.run({ id, ...need, priority: priority === 'batch' ? 'batch' : 'interactive' }, async () => this.invoke(id, await this.connect(id, spec), capability, rest, timeoutMs));
    }
    return this.invoke(id, e, capability, args, timeoutMs);
  }

  async invoke(id, e, capability, args, timeoutMs) {
    const tool = e.tools.get(capability);
    if (!tool) throw new Error(`${id} has no tool ${capability}`);
    let result;
    if (tool.execution?.taskSupport === 'required') {
      for await (const msg of e.client.experimental.tasks.callToolStream({ name: capability, arguments: args }, CallToolResultSchema, { task: { ttl: timeoutMs }, timeout: timeoutMs })) {
        if (msg.type === 'result') result = msg.result;
        if (msg.type === 'error') throw new Error(msg.error?.message ?? 'engine error');
      }
    } else result = await e.client.callTool({ name: capability, arguments: args }, CallToolResultSchema, { timeout: timeoutMs, resetTimeoutOnProgress: true });
    if (!result) throw new Error(`${id} gave no result`);
    if (result.isError) throw new Error(result.content?.find((c) => c.type === 'text')?.text ?? `${id} failed`);
    const c = result.structuredContent;
    if (!c) throw new Error(`${id} returned no contribution (structuredContent)`);
    return { ...c, ...(c.files ? { files: c.files.map((f) => ({ ...f, uri: inline(f.uri) })) } : {}) };
  }

  async drop(id) {
    this.scheduler.forget(id);
    const e = this.live.get(id);
    this.live.delete(id);
    await e?.client.close().catch(() => {});
  }

  async close() {
    await Promise.all([...this.live.keys()].map((id) => this.drop(id)));
  }
}
