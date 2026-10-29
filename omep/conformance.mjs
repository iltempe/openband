#!/usr/bin/env node
// omep-conformance: start (or connect to) an OMEP engine and check it against OMEP 1.0 —
// protocol, manifest, schemas, tasks, cancellation, determinism, licence — and measure how well what it
// makes respects the song (tempo, key, length, range): the adherence score the router uses.
//
//   node omep/conformance.mjs [--context ctx.json] [--json] [--min-adherence 0.5] -- <command> [args…]
//   node omep/conformance.mjs --url https://host/mcp [--token T]
//
// Exit code 0 when every required check passes (and adherence ≥ --min-adherence, if given).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { CATALOG, EXTENSION, validate } from './lib/schemas.mjs';
import { decodeWav, encodeWav, estimateBpm, estimateKey, keyOfNotes } from './lib/audio.mjs';
import { beatsPerBar, keySimilarity, noteNumber, scalePcs } from './lib/music.mjs';
import { decodeFrame, frameBeats, SAMPLE_RATE, STREAM_PROTOCOL } from './lib/stream.mjs';
import { WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTEXT = JSON.parse(fs.readFileSync(path.join(here, 'examples', 'context.json'), 'utf8'));

/**
 * For a capability that works on the song's audio (conditioning context_audio: restyle, repaint, a layer
 * over the mix): the context with a mix to work on — the scope's chords as plain tones, a data: WAV.
 */
export function withContextAudio(context) {
  if (context.context_audio?.mix_uri) return context;
  const bpb = beatsPerBar(context.song?.meter ?? '4/4');
  const from = context.scope?.from_bar ?? 1;
  const to = context.scope?.to_bar ?? from + 4;
  const spb = 60 / (context.song?.bpm ?? 120);
  const seconds = (to - from) * bpb * spb;
  const sr = 22050;
  const x = new Float32Array(Math.round(seconds * sr));
  const minor = /m$/.test(String(context.song?.key ?? ''));
  const root = noteNumber(String(context.song?.key ?? 'C').replace(/m$/, '') + '3') ?? 48;
  // A chord struck on every beat, so tempo and key can be heard in it.
  const beat = Math.round(spb * sr);
  for (let i = 0; i < x.length; i++) {
    const t = (i % beat) / sr;
    const env = Math.exp(-t * 6);
    for (const st of [0, minor ? 3 : 4, 7]) x[i] += 0.2 * env * Math.sin((2 * Math.PI * 440 * 2 ** ((root + st - 69) / 12) * i) / sr);
  }
  return { ...context, context_audio: { mix_uri: `data:audio/wav;base64,${encodeWav([x], sr).toString('base64')}`, from_bar: from, to_bar: to } };
}

/** 1 within `tol` (relative), falling to 0 at 4×tol. */
const closeness = (got, want, tol) => {
  const e = Math.abs(got - want) / want;
  return e <= tol ? 1 : Math.max(0, 1 - (e - tol) / (3 * tol));
};

async function readFileUri(uri) {
  if (uri.startsWith('file://')) return fs.readFileSync(new URL(uri));
  if (uri.startsWith('data:')) return Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`${uri}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** How well a contribution respects the context: a score per aspect, and what the claims say. */
export async function measure(contribution, scp) {
  const bpb = beatsPerBar(scp.song.meter);
  const from = scp.scope?.from_bar ?? 1;
  const to = scp.scope?.to_bar ?? from + scp.song.length_bars;
  const bars = to - from;
  const scores = {};
  const notes = [];
  if (contribution.kind === 'notes') {
    const ns = contribution.notes ?? [];
    const beats = bars * bpb;
    scores.length = ns.length ? ns.filter((n) => n.start >= 0 && n.start + n.duration <= beats + 0.01).length / ns.length : 0;
    const drums = ns.length && ns.every((n) => n.pitch >= 35 && n.pitch <= 59) && contribution.claims?.key === undefined;
    if (!drums && ns.length) {
      const pcs = scalePcs(scp.song.key);
      scores.key = ns.filter((n) => pcs.has(n.pitch % 12)).length / ns.length;
      const range = scp.constraints?.hard?.range?.map(noteNumber);
      if (range) scores.range = ns.filter((n) => n.pitch >= range[0] && n.pitch <= range[1]).length / ns.length;
      notes.push(`key of the notes: ${keyOfNotes(ns)}`);
    }
  }
  if (contribution.kind === 'audio' || contribution.kind === 'stems') {
    for (const f of contribution.files ?? []) {
      if (f.format !== 'wav') {
        notes.push(`${f.role}: ${f.format} not measured (only WAV is decoded here)`);
        continue;
      }
      const { sampleRate, channels } = decodeWav(await readFileUri(f.uri));
      const seconds = channels[0].length / sampleRate;
      const want = (bars * bpb * 60) / scp.song.bpm;
      scores.length = Math.min(scores.length ?? 1, closeness(seconds, want, 0.02));
      const bpm = estimateBpm(channels, sampleRate);
      const tempoScore = Math.max(closeness(bpm, scp.song.bpm, 0.02), 0.5 * Math.max(closeness(bpm * 2, scp.song.bpm, 0.02), closeness(bpm / 2, scp.song.bpm, 0.02)));
      scores.bpm = Math.min(scores.bpm ?? 1, tempoScore);
      const key = estimateKey(channels, sampleRate);
      scores.key = Math.min(scores.key ?? 1, keySimilarity(key, scp.song.key));
      notes.push(`${f.role}: ${seconds.toFixed(2)} s (want ${want.toFixed(2)}), ~${bpm} BPM, key ${key}`);
      if (contribution.claims?.key && keySimilarity(key, contribution.claims.key) < 1) notes.push(`claims key ${contribution.claims.key}, sounds like ${key}`);
    }
  }
  const values = Object.values(scores);
  return { scores, adherence: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 1, notes };
}

/**
 * stream.jam (OMEP stream 1.0, lib/stream.mjs): open a session, play a transport at the context's tempo
 * for a few seconds and check what arrives — the handshake, frames that decode, contiguous beats, how far
 * ahead of their beat they arrive, the clock answers — then close it.
 */
async function streamSuite(client, manifest, context, check, cases, timeoutMs, seconds = 4) {
  const cap = 'stream.jam';
  const t0 = Date.now();
  let r;
  try {
    r = await client.callTool({ name: cap, arguments: { context, request: { action: 'open', style: 'warm, sparse', intensity: 0.4 } } }, CallToolResultSchema, { timeout: timeoutMs });
  } catch (e) {
    return void check(`${cap}: opens a stream`, false, e.message);
  }
  const c = r.structuredContent;
  const errs = c ? validate('contribution', c) : [r.content?.[0]?.text ?? 'no structuredContent'];
  check(`${cap}: contribution is valid`, !r.isError && errs.length === 0, errs.join('; '));
  if (r.isError || errs.length) return;
  check(`${cap}: output kind fits the capability`, c.kind === 'stream', c.kind);
  check(`${cap}: ws-pcm with the clock on the same socket`, c.stream.transport === 'ws-pcm' && /^wss?:\/\//.test(c.stream.url) && c.stream.protocol === STREAM_PROTOCOL, `${c.stream.transport} ${c.stream.url} ${c.stream.protocol ?? '(no protocol)'}`);
  check(`${cap}: provenance names the engine`, c.provenance.engine === manifest.engine.id, c.provenance.engine);
  const bpm = context.song?.bpm ?? 120;
  const frames = [];
  const acks = [];
  let ready = null;
  let failure = null;
  await new Promise((done) => {
    const ws = new WebSocket(c.stream.url);
    ws.binaryType = 'arraybuffer';
    const start = performance.now() + 1000; // the stream's beat 0, a second from now
    const beatAt = (t) => ((t - start) / 60000) * bpm;
    let seq = 0;
    let timer = null;
    const stop = setTimeout(() => ws.close(), seconds * 1000 + 1200);
    ws.on('open', () => {
      timer = setInterval(() => ws.send(JSON.stringify({ type: 'clock', seq: seq++, beat: beatAt(performance.now()), bpm, playing: true, lead_ms: 300, epoch: 1, sent_ms: performance.now() })), 50);
    });
    ws.on('message', (data, binary) => {
      if (!binary) {
        const m = JSON.parse(String(data));
        if (m.type === 'ready') ready = m;
        if (m.type === 'clock_ack') acks.push({ ...m, rtt: performance.now() - m.sent_ms });
        if (m.type === 'error') failure = m.message;
        return;
      }
      try {
        const f = decodeFrame(data);
        frames.push({ ...f, marginMs: ((f.beat - beatAt(performance.now())) * 60000) / bpm, samples: undefined, peak: Math.max(...f.samples.map(Math.abs)) });
      } catch (e) {
        failure = e.message;
      }
    });
    ws.on('error', (e) => {
      failure = e.message;
      clearTimeout(stop);
      done();
    });
    ws.on('close', () => {
      clearInterval(timer);
      clearTimeout(stop);
      done();
    });
  });
  check(`${cap}: handshake (ready, 48 kHz)`, ready?.protocol === STREAM_PROTOCOL && ready.sample_rate === SAMPLE_RATE, ready ? JSON.stringify(ready) : failure ?? 'no ready message');
  const sorted = [...frames].sort((a, b) => a.beat - b.beat);
  const step = sorted[0] ? frameBeats(sorted[0].frames, sorted[0].sampleRate, bpm) : 0;
  const holes = sorted.slice(1).filter((f, i) => Math.abs(f.beat - (sorted[i].beat + step)) > 1e-6).length;
  const covered = sorted.length * step;
  check(`${cap}: frames decode, 48 kHz, from beat 0`, frames.length > 0 && !failure && sorted.every((f) => f.sampleRate === SAMPLE_RATE) && Math.abs(sorted[0].beat) < 1e-9, failure ?? `${frames.length} frames, first at beat ${sorted[0]?.beat}`);
  check(`${cap}: contiguous beats, no holes`, frames.length > 0 && holes === 0, `${holes} hole(s)`);
  check(`${cap}: keeps up with real time`, covered >= ((seconds - 0.5) * bpm) / 60, `${covered.toFixed(2)} beats in ${seconds} s at ${bpm} BPM`);
  const late = frames.filter((f) => f.marginMs < 0).length;
  check(`${cap}: frames arrive before their beat`, frames.length > 0 && late / frames.length <= 0.02, `${late} of ${frames.length} late`);
  check(`${cap}: answers the clock (clock_ack)`, acks.length > 0, `${acks.length} answers`);
  check(`${cap}: not silent`, frames.some((f) => f.peak > 0.01), '', false);
  const margins = frames.map((f) => f.marginMs).sort((a, b) => a - b);
  const rtt = acks.map((a) => a.rtt).sort((a, b) => a - b);
  try {
    const closed = await client.callTool({ name: cap, arguments: { context, request: { action: 'close', session: c.stream.session } } }, CallToolResultSchema, { timeout: timeoutMs });
    check(`${cap}: closes`, !closed.isError, '', false);
  } catch (e) {
    check(`${cap}: closes`, false, e.message, false);
  }
  cases.push({
    capability: cap,
    ms: Date.now() - t0,
    scores: { continuity: holes === 0 ? 1 : 0, punctuality: frames.length ? 1 - late / frames.length : 0 },
    adherence: frames.length ? ((holes === 0 ? 1 : 0) + 1 - late / frames.length) / 2 : 0,
    notes: [`${frames.length} frames`, `min margin ${margins[0]?.toFixed(0) ?? '–'} ms`, `rtt median ${rtt[rtt.length >> 1]?.toFixed(1) ?? '–'} ms`, ...(acks.at(-1)?.gen_ms !== undefined ? [`render ${acks.at(-1).gen_ms} ms/frame`] : [])],
  });
}

const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Run the suite. `target`: { command, args, env } (stdio) or { url, token } (Streamable HTTP). */
export async function runConformance(target, { context = DEFAULT_CONTEXT, timeoutMs = 120000 } = {}) {
  const checks = [];
  const cases = [];
  const check = (id, ok, detail = '', required = true) => checks.push({ id, ok: !!ok, detail, required });
  const client = new Client({ name: 'omep-conformance', version: '1.0.0' });
  const transport = target.url
    ? new StreamableHTTPClientTransport(new URL(target.url), target.token ? { requestInit: { headers: { authorization: `Bearer ${target.token}` } } } : undefined)
    : new StdioClientTransport({ command: target.command, args: target.args ?? [], env: { ...process.env, ...(target.env ?? {}) }, stderr: 'ignore' });
  let manifest = null;
  try {
    await client.connect(transport);
    const caps = client.getServerCapabilities() ?? {};
    check('declares the OMEP extension', caps.experimental?.[EXTENSION] || caps.extensions?.[EXTENSION], `capabilities.experimental["${EXTENSION}"]`);
    check('context is a valid Song Context Package', validate('scp', context).length === 0, validate('scp', context).join('; '));

    try {
      const res = await client.readResource({ uri: 'omep://manifest' });
      manifest = JSON.parse(res.contents[0].text);
      const errs = validate('manifest', manifest);
      check('manifest omep://manifest is valid', errs.length === 0, errs.join('; '));
    } catch (e) {
      check('manifest omep://manifest is readable', false, e.message);
      return finish();
    }

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const declared = Object.keys(manifest.capabilities ?? {});
    for (const cap of declared) {
      const t = byName.get(cap);
      check(`tool for ${cap}`, t && (t.inputSchema?.required ?? []).includes('context'), t ? 'its input must require "context"' : 'missing');
    }

    for (const cap of declared) {
      if (!byName.has(cap)) continue;
      if (!CATALOG[cap]) {
        check(`${cap}: experimental capability`, true, 'vendor capability, not measured', false);
        continue;
      }
      if (cap === 'stream.jam') {
        await streamSuite(client, manifest, context, check, cases, timeoutMs);
        continue;
      }
      const t0 = Date.now();
      let r;
      try {
        const input = (manifest.capabilities[cap]?.conditioning ?? []).includes('context_audio') ? withContextAudio(context) : context;
        r = await client.callTool({ name: cap, arguments: { context: input, seed: 7 } }, CallToolResultSchema, { timeout: timeoutMs });
      } catch (e) {
        check(`${cap}: answers`, false, e.message);
        continue;
      }
      const ms = Date.now() - t0;
      if (r.isError) {
        check(`${cap}: answers`, false, r.content?.[0]?.text ?? 'error');
        continue;
      }
      const c = r.structuredContent;
      const errs = c ? validate('contribution', c) : ['no structuredContent'];
      check(`${cap}: contribution is valid`, errs.length === 0, errs.join('; '));
      if (errs.length) continue;
      check(`${cap}: output kind fits the capability`, CATALOG[cap].output.includes(c.kind), `${c.kind} (expected ${CATALOG[cap].output.join(' or ')})`);
      check(`${cap}: provenance names the engine`, c.provenance.engine === manifest.engine.id, c.provenance.engine);
      check(`${cap}: licence copied from the manifest`, digest(c.license) === digest(manifest.license), '', false);
      const m = await measure(c, context);
      cases.push({ capability: cap, ms, ...m });
    }

    // Same seed, same result (seeded / deterministic engines).
    const first = declared.find((cap) => byName.has(cap) && CATALOG[cap] && cap !== 'stream.jam');
    if (first && manifest.determinism !== 'stochastic') {
      const a = await client.callTool({ name: first, arguments: { context, seed: 11 } }, CallToolResultSchema, { timeout: timeoutMs });
      const b = await client.callTool({ name: first, arguments: { context, seed: 11 } }, CallToolResultSchema, { timeout: timeoutMs });
      const sig = async (c) => (c?.notes ? digest(c.notes) : digest(await Promise.all((c?.files ?? []).map(async (f) => crypto.createHash('sha256').update(await readFileUri(f.uri)).digest('hex')))));
      check(`${first}: same seed, same result`, (await sig(a.structuredContent)) === (await sig(b.structuredContent)), manifest.determinism);
    }

    // Tasks: created, polled, result; and a cancellation.
    const taskTool = tools.find((t) => ['optional', 'required'].includes(t.execution?.taskSupport) && CATALOG[t.name] && t.name !== 'stream.jam');
    if (taskTool) {
      check('declares tasks for tools/call', caps.tasks?.requests?.tools?.call, 'capabilities.tasks.requests.tools.call');
      const seen = [];
      let result = null;
      for await (const msg of client.experimental.tasks.callToolStream({ name: taskTool.name, arguments: { context } }, CallToolResultSchema, { task: { ttl: 60000 }, timeout: timeoutMs })) {
        seen.push(msg.type);
        if (msg.type === 'result') result = msg.result;
        if (msg.type === 'error') seen.push(msg.error?.message ?? 'error');
      }
      check(`${taskTool.name}: runs as a task`, seen[0] === 'taskCreated' && result && validate('contribution', result.structuredContent).length === 0, seen.join(' → '));
      let taskId = null;
      for await (const msg of client.experimental.tasks.callToolStream({ name: taskTool.name, arguments: { context } }, CallToolResultSchema, { task: { ttl: 60000 }, timeout: timeoutMs })) {
        if (msg.type === 'taskCreated') {
          taskId = msg.task.taskId;
          await client.experimental.tasks.cancelTask(taskId).catch(() => {});
          break;
        }
      }
      const after = taskId ? await client.experimental.tasks.getTask(taskId).catch((e) => ({ status: `error: ${e.message}` })) : null;
      check(`${taskTool.name}: can be cancelled`, after && ['cancelled', 'completed'].includes(after.status), after ? `status ${after.status}${after.status === 'completed' ? ' (finished before the cancel arrived)' : ''}` : 'no task');
    } else if (manifest.runtime?.realtime === false) check('long-running tools use MCP tasks', false, 'no tool declares execution.taskSupport (allowed, but clients then wait synchronously)', false);

    if (manifest.license.commercial !== 'yes') check('licence allows commercial use', false, `${manifest.license.commercial}: excluded while the user's policy is commercial_only`, false);
  } catch (e) {
    check('engine runs', false, e.message);
  } finally {
    await client.close().catch(() => {});
  }
  return finish();

  function finish() {
    const adherence = cases.length ? cases.reduce((s, c) => s + c.adherence, 0) / cases.length : null;
    return { engine: manifest?.engine ?? null, omep: manifest?.omep ?? null, passed: checks.every((c) => c.ok || !c.required), adherence, checks, cases };
  }
}

export function formatReport(r) {
  const lines = [`OMEP conformance — ${r.engine ? `${r.engine.name} ${r.engine.version}` : 'unknown engine'}`];
  for (const c of r.checks) lines.push(`${c.ok ? '✓' : c.required ? '✗' : '!'} ${c.id}${c.detail ? ` — ${c.detail}` : ''}`);
  for (const c of r.cases) lines.push(`  ${c.capability}: adherence ${(c.adherence * 100).toFixed(0)}% ${JSON.stringify(Object.fromEntries(Object.entries(c.scores).map(([k, v]) => [k, +v.toFixed(2)])))} in ${c.ms} ms${c.notes.length ? ` · ${c.notes.join(' · ')}` : ''}`);
  lines.push(`${r.passed ? 'PASSED' : 'FAILED'}${r.adherence === null ? '' : ` · adherence ${(r.adherence * 100).toFixed(0)}%`}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const opts = sep >= 0 ? argv.slice(0, sep) : argv;
  const cmd = sep >= 0 ? argv.slice(sep + 1) : [];
  const opt = (name) => {
    const i = opts.indexOf(name);
    return i >= 0 ? opts[i + 1] : undefined;
  };
  if (!cmd.length && !opt('--url')) {
    console.error('usage: omep-conformance [--context ctx.json] [--json] [--min-adherence 0.5] -- <command> [args…]\n       omep-conformance --url https://host/mcp [--token T]');
    process.exit(2);
  }
  const context = opt('--context') ? JSON.parse(fs.readFileSync(opt('--context'), 'utf8')) : DEFAULT_CONTEXT;
  const target = opt('--url') ? { url: opt('--url'), token: opt('--token') } : { command: cmd[0], args: cmd.slice(1) };
  const r = await runConformance(target, { context });
  console.log(opts.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
  const min = opt('--min-adherence') ? Number(opt('--min-adherence')) : null;
  process.exit(r.passed && (min === null || (r.adherence ?? 0) >= min) ? 0 : 1);
}
