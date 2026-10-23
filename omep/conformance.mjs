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
import { decodeWav, estimateBpm, estimateKey, keyOfNotes } from './lib/audio.mjs';
import { beatsPerBar, keySimilarity, noteNumber, scalePcs } from './lib/music.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTEXT = JSON.parse(fs.readFileSync(path.join(here, 'examples', 'context.json'), 'utf8'));

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
        check(`${cap}: streaming`, true, 'measured by the streaming suite (OMEP 1.0 §2.5)', false);
        continue;
      }
      const t0 = Date.now();
      let r;
      try {
        r = await client.callTool({ name: cap, arguments: { context, seed: 7 } }, CallToolResultSchema, { timeout: timeoutMs });
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
