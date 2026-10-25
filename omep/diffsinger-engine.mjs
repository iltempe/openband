#!/usr/bin/env node
// DiffSinger on your computer as an OMEP 1.0 singing engine (voice.sing, SPEC v0.6 §10):
//   node omep/diffsinger-engine.mjs --repo ~/DiffSinger --exp my_voice [--python ~/DiffSinger/.venv/bin/python]
// You install DiffSinger (openvpi, Apache-2.0) and a voicebank yourself; OpenBand writes the .ds from the
// song (notes, syllables and the phonemes it computed — Italian by rule) and runs the acoustic model.
// In ~/.openband/engines.json:
//   "diffsinger": { "builtin": "omep-diffsinger", "repo": "…/DiffSinger", "exp": "my_voice",
//                   "python": "…/bin/python", "languages": ["it"], "phonemes": { "E": "e" },
//                   "voicebank": { "name": "…", "license": "CC-BY-4.0", "commercial": "yes", "url": "…" } }
// "phonemes" maps OpenBand's symbols to the voicebank's where they differ; "lang_prefix" for multilingual
// banks ("it/"); "spk" picks a speaker. Every voicebank has its own licence: it is in the manifest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { EXTENSION } from './lib/schemas.mjs';
import { DIFFSINGER_LICENSE_CODE, runDiffSinger, sungNotes, toDs } from './lib/diffsinger.mjs';
import { decodeWav, encodeWav } from './lib/audio.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith(`${name}=`))?.split('=').slice(1).join('=');
};
const json = (v, d) => {
  try {
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
};
const cfg = {
  repo: arg('--repo') ?? process.env.DIFFSINGER_REPO,
  exp: arg('--exp') ?? process.env.DIFFSINGER_EXP,
  python: arg('--python') ?? process.env.DIFFSINGER_PYTHON ?? 'python',
  spk: arg('--spk') ?? process.env.DIFFSINGER_SPK,
  lang: arg('--lang') ?? process.env.DIFFSINGER_LANG,
  langPrefix: arg('--lang-prefix') ?? process.env.DIFFSINGER_LANG_PREFIX ?? '',
  phonemes: json(arg('--phonemes') ?? process.env.DIFFSINGER_PHONEMES, {}),
  languages: json(arg('--languages') ?? process.env.DIFFSINGER_LANGUAGES, ['it', 'en']),
  voicebank: json(arg('--voicebank') ?? process.env.DIFFSINGER_VOICEBANK, {}),
};
const vb = cfg.voicebank;

export const MANIFEST = {
  omep: '1.0',
  engine: { id: 'diffsinger', name: `DiffSinger${vb.name ? ` · ${vb.name}` : cfg.exp ? ` · ${cfg.exp}` : ''}`, version: '2.0.0', homepage: 'https://github.com/openvpi/DiffSinger' },
  // The code is Apache-2.0; what you may do with the voice is the voicebank's licence.
  license: { code: DIFFSINGER_LICENSE_CODE, weights: vb.license ?? 'unknown', commercial: vb.commercial ?? 'conditional', attribution: vb.attribution ?? (/^CC-BY/i.test(vb.license ?? '') ? `Voice: ${vb.name ?? cfg.exp}${vb.author ? ` by ${vb.author}` : ''} (${vb.license})` : null), conditions: vb.conditions ?? (vb.license ? null : 'the voicebank’s own licence — check it before releasing'), url: vb.url ?? 'https://github.com/openvpi/DiffSinger/blob/main/LICENSE' },
  runtime: { where: 'local', device: ['cuda', 'cpu', 'mps'], realtime: false },
  capabilities: { 'voice.sing': { conditioning: ['melody', 'lyrics', 'phonemes', 'bpm'] } },
  outputs: ['audio/wav'],
  languages: cfg.languages,
  determinism: 'seeded',
};

/** Seconds of pre-roll, so the first consonants have time before the first note; cut off the answer. */
const PRE = 0.3;

async function perform(args, signal) {
  if (!cfg.repo || !cfg.exp) throw new Error('DiffSinger is not configured: set "repo" (your DiffSinger folder) and "exp" (the voicebank) for this engine in ~/.openband/engines.json');
  const scp = args.context;
  const notes = sungNotes(scp).map((n) => ({ ...n, start: n.start + PRE, end: n.end + PRE }));
  if (!notes.length) throw new Error('Nothing to sing: no melody notes in those bars');
  const ds = toDs(notes, { phonemes: cfg.phonemes, langPrefix: cfg.langPrefix });
  const { bytes, dir } = await runDiffSinger(ds, { ...cfg, seed: args.seed ?? 1, signal });
  // The scope exactly: without the pre-roll, padded with silence to its length.
  const w = decodeWav(bytes);
  const bpb = Number(String(scp.song?.meter ?? '4/4').split('/')[0]) || 4;
  const from = scp.scope?.from_bar ?? 1;
  const bars = (scp.scope?.to_bar ?? from + (scp.song?.length_bars ?? 8)) - from;
  const n = Math.round(((bars * bpb * 60) / scp.song.bpm) * w.sampleRate);
  const skip = Math.round(PRE * w.sampleRate);
  const ch = w.channels.map((c) => {
    const out = new Float32Array(n);
    out.set(c.subarray(skip, skip + n));
    return out;
  });
  const file = path.join(os.tmpdir(), `omep-diffsinger-${process.pid}-${Date.now().toString(36)}.wav`);
  fs.writeFileSync(file, encodeWav(ch, w.sampleRate));
  fs.rmSync(dir, { recursive: true, force: true });
  const words = notes.filter((x) => x.text);
  return {
    kind: 'audio',
    files: [{ uri: pathToFileURL(file).href, role: 'vocal', format: 'wav', sample_rate: w.sampleRate, channels: ch.length }],
    alignment: { start_bar: from, syllables: words.map((x) => ({ text: x.text, start_ms: Math.round((x.start - PRE) * 1000), end_ms: Math.round((x.end - PRE) * 1000) })) },
    claims: { bpm: scp.song.bpm, key: scp.song.key, length_bars: bars },
    provenance: { engine: 'diffsinger', engine_version: `2.0.0 (${cfg.exp})`, model_hash: 'none', seed: args.seed ?? 1, capability: 'voice.sing', voice: vb.name ?? cfg.exp, prompt: words.map((x) => x.text).join(' ').slice(0, 200) || undefined },
    license: MANIFEST.license,
  };
}

const taskStore = new InMemoryTaskStore();
/** One MCP server (they share the task store): one for stdio, one per HTTP session. */
function makeServer(inline) {
  const server = new McpServer({ name: 'diffsinger', version: '2.0.0' }, { capabilities: { experimental: { [EXTENSION]: { version: '1.0' } }, tasks: { requests: { tools: { call: {} } } } }, taskStore });
  server.registerResource('manifest', 'omep://manifest', { title: 'OMEP manifest', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(MANIFEST, null, 2) }] }));
  server.experimental.tasks.registerToolTask(
    'voice.sing',
    { title: 'voice.sing', description: `DiffSinger (${cfg.exp ?? 'not configured'}): OMEP voice.sing`, inputSchema: { context: z.looseObject({}), request: z.looseObject({}).optional(), seed: z.number().int().optional(), variants: z.number().int().min(1).max(8).optional() }, execution: { taskSupport: 'optional' } },
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
            const c = await perform(args, abort.signal);
            // Over the network the file stays here: the audio goes back inline.
            if (inline) c.files = c.files.map((f) => ({ ...f, uri: `data:audio/wav;base64,${fs.readFileSync(fileURLToPath(f.uri)).toString('base64')}` }));
            await store.storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: `voice.sing: DiffSinger sang ${c.claims.length_bars} bars` }], structuredContent: c });
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
  return server;
}

const port = arg('--http');
if (!port) await makeServer(false).connect(new StdioServerTransport());
else {
  // On a GPU machine (deploy/diffsinger): Streamable HTTP at /mcp, with a bearer token (OMEP_TOKEN).
  const host = arg('--host') ?? '127.0.0.1';
  const token = process.env.OMEP_TOKEN;
  if (!token && host !== '127.0.0.1' && host !== 'localhost') {
    console.error('omep-diffsinger: set OMEP_TOKEN before listening beyond this computer');
    process.exit(2);
  }
  const sessions = new Map();
  http
    .createServer(async (req, res) => {
      if (token && req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end('wrong token');
      if (!req.url?.startsWith('/mcp')) return void res.writeHead(404).end();
      let body;
      if (req.method === 'POST') {
        let raw = '';
        for await (const c of req) raw += c;
        body = raw ? JSON.parse(raw) : undefined;
      }
      const sid = req.headers['mcp-session-id'];
      let t = sid ? sessions.get(sid) : undefined;
      if (!t) {
        if (sid) return void res.writeHead(404).end('unknown session');
        t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, t) });
        t.onclose = () => t.sessionId && sessions.delete(t.sessionId);
        await makeServer(true).connect(t);
      }
      await t.handleRequest(req, res, body);
    })
    .listen(Number(port), host, () => console.error(`omep-diffsinger on http://${host}:${port}/mcp`));
}
