// omep-comfyui (SPEC v0.6 §10, E6): the user's own ComfyUI workflows as OMEP capabilities, through a
// declarative mapping — which workflow plays which capability, and which node input gets which part of
// the Song Context Package. Nothing of the workflow is guessed: the user exports it from ComfyUI with
// File → Export (API) and says where the song goes.
//
//   {
//     "name": "My ComfyUI",
//     "license": { "code": "GPL-3.0", "weights": "…", "commercial": "yes", "attribution": null, "conditions": null },
//     "capabilities": {
//       "music.song": {
//         "workflow": "ace-step.api.json",            // relative to this file
//         "inputs": {
//           "14.tags": "{intent.text}, {song.bpm} bpm, {song.key_scale}",   // a template
//           "14.lyrics": "lyrics.text",                                     // a value of the context
//           "17.seconds": "scope.seconds",
//           "3.seed": "seed",
//           "3.steps": { "value": 50 }                                      // a constant
//         },
//         "output": "19",                              // the save node (default: the first audio output)
//         "role": "full"
//       }
//     }
//   }
//
// Values: song.bpm, song.key, song.key_scale ("D minor"), song.meter, song.beats_per_bar, song.title,
// scope.seconds, scope.bars, scope.from_bar, intent.text, intent.role, lyrics.text (the lines, or
// "[Instrumental]"), lyrics.language, request.text, request.strength (0..1), request.denoise
// (1 − strength), seed, and context_audio.mix (the song's audio, uploaded to ComfyUI's input folder: the
// value is the file name a LoadAudio node takes).
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG } from './schemas.mjs';
import { keyScale, scopeTimes } from './acestep.mjs';

const AUDIO_EXT = { '.wav': 'wav', '.flac': 'flac', '.mp3': 'mp3', '.ogg': 'ogg', '.opus': 'ogg' };
const MIME = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', ogg: 'audio/ogg' };
const VALUES = new Set([
  'song.bpm', 'song.key', 'song.key_scale', 'song.meter', 'song.beats_per_bar', 'song.title',
  'scope.seconds', 'scope.bars', 'scope.from_bar', 'intent.text', 'intent.role', 'lyrics.text', 'lyrics.language',
  'request.text', 'request.strength', 'request.denoise', 'seed', 'context_audio.mix',
]);

/** Read and check a mapping file: every workflow exists, every binding names a node and input that are there. */
export function readMapping(file) {
  const full = path.resolve(file);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    throw new Error(`The ComfyUI mapping ${full}: ${e.message}`);
  }
  const errors = [];
  const caps = {};
  for (const [cap, c] of Object.entries(m.capabilities ?? {})) {
    if (!CATALOG[cap]) errors.push(`${cap}: not an OMEP capability`);
    if (!CATALOG[cap]?.output?.includes('audio')) errors.push(`${cap}: omep-comfyui plays capabilities that make audio`);
    const wfFile = path.resolve(path.dirname(full), String(c.workflow ?? ''));
    let workflow = null;
    try {
      workflow = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
    } catch (e) {
      errors.push(`${cap}: workflow ${c.workflow}: ${e.code === 'ENOENT' ? 'not found' : e.message}`);
      continue;
    }
    if (!workflow || typeof workflow !== 'object' || Object.values(workflow).some((n) => !n?.class_type)) {
      errors.push(`${cap}: ${c.workflow} is not in ComfyUI's API format (File → Export (API))`);
      continue;
    }
    for (const [target, source] of Object.entries(c.inputs ?? {})) {
      const [node, input] = target.split('.');
      if (!workflow[node]) errors.push(`${cap}: node ${node} is not in ${c.workflow}`);
      else if (!input) errors.push(`${cap}: "${target}" must be node.input`);
      for (const v of sourcesOf(source)) if (!VALUES.has(v)) errors.push(`${cap}: ${target} ← unknown value "${v}"`);
    }
    if (c.output && !workflow[c.output]) errors.push(`${cap}: output node ${c.output} is not in ${c.workflow}`);
    caps[cap] = { workflow, inputs: c.inputs ?? {}, output: c.output ? String(c.output) : null, role: c.role ?? (cap === 'music.song' || cap === 'music.restyle' ? 'full' : 'layer'), file: wfFile };
  }
  if (!Object.keys(caps).length && !errors.length) errors.push('no capabilities');
  if (errors.length) throw new Error(`The ComfyUI mapping ${full}:\n  ${errors.join('\n  ')}`);
  return { name: m.name ?? 'ComfyUI', license: m.license ?? null, capabilities: caps };
}

/** The context values a binding reads. */
function sourcesOf(source) {
  if (source && typeof source === 'object') return [];
  const s = String(source);
  return s.includes('{') ? [...s.matchAll(/\{([a-z_.]+)\}/g)].map((x) => x[1]) : [s];
}

/** What a capability conditions on, from what its bindings read (for the manifest). */
export function conditioningOf(inputs) {
  const used = new Set(Object.values(inputs).flatMap(sourcesOf));
  const out = new Set();
  for (const v of used) {
    if (v === 'song.bpm') out.add('bpm');
    if (v === 'song.key' || v === 'song.key_scale') out.add('key');
    if (v === 'song.meter' || v === 'song.beats_per_bar') out.add('meter');
    if (v.startsWith('lyrics.')) out.add('lyrics');
    if (v === 'intent.text' || v === 'request.text') out.add('text');
    if (v === 'context_audio.mix') out.add('context_audio');
  }
  return [...out];
}

/** The value of one context path (context_audio.mix is resolved by the engine, which uploads it). */
export function valueOf(name, scp, request = {}, seed = 1) {
  const s = scopeTimes(scp);
  const strength = Number.isFinite(request.strength) ? Math.max(0, Math.min(1, request.strength)) : 0.5;
  switch (name) {
    case 'song.bpm': return scp.song?.bpm ?? 120;
    case 'song.key': return scp.song?.key ?? '';
    case 'song.key_scale': return keyScale(scp.song?.key ?? '');
    case 'song.meter': return scp.song?.meter ?? '4/4';
    case 'song.beats_per_bar': return Number(String(scp.song?.meter ?? '4/4').split('/')[0]) || 4;
    case 'song.title': return scp.song?.title ?? '';
    case 'scope.seconds': return +s.seconds.toFixed(2);
    case 'scope.bars': return s.bars;
    case 'scope.from_bar': return scp.scope?.from_bar ?? 1;
    case 'intent.text': return [request.text, scp.intent?.text].filter(Boolean).join(', ');
    case 'intent.role': return scp.intent?.role ?? '';
    case 'lyrics.text': {
      if (typeof request.lyrics === 'string' && request.lyrics.trim()) return request.lyrics;
      const lines = (scp.lyrics?.lines ?? []).map((l) => l.text).filter(Boolean);
      return lines.length ? lines.join('\n') : '[Instrumental]';
    }
    case 'lyrics.language': return scp.lyrics?.language ?? 'en';
    case 'request.text': return request.text ?? '';
    case 'request.strength': return strength;
    case 'request.denoise': return +(1 - strength).toFixed(3);
    case 'seed': return seed;
    default: throw new Error(`Unknown value ${name}`);
  }
}

/**
 * The workflow to queue: a copy with the song filled in. `uploaded`: the file name ComfyUI gave the
 * song's audio (context_audio.mix).
 */
export function fillWorkflow(cap, scp, request, seed, uploaded) {
  const wf = structuredClone(cap.workflow);
  const read = (v) => {
    if (v === 'context_audio.mix') {
      if (!uploaded) throw new Error('This workflow needs the song\'s audio (context_audio)');
      return uploaded;
    }
    return valueOf(v, scp, request, seed);
  };
  for (const [target, source] of Object.entries(cap.inputs)) {
    const [node, input] = target.split('.');
    let value;
    if (source && typeof source === 'object') value = source.value;
    else if (String(source).includes('{')) value = String(source).replace(/\{([a-z_.]+)\}/g, (_, v) => String(read(v))).replace(/(^[\s,]+|[\s,]+$)/g, '').replace(/,\s*,/g, ',');
    else value = read(String(source));
    wf[node].inputs[input] = value;
  }
  return wf;
}

/** ComfyUI's HTTP API (server.py): queue, history, view, upload. */
export class ComfyClient {
  constructor({ base = 'http://127.0.0.1:8188', fetch: f = globalThis.fetch, clientId } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.fetch = f;
    this.clientId = clientId ?? `omep-${Math.random().toString(36).slice(2)}`;
  }

  async request(p, init) {
    let res;
    try {
      res = await this.fetch(`${this.base}${p}`, init);
    } catch (e) {
      throw new Error(`ComfyUI is not answering at ${this.base} (${e.cause?.code ?? e.message}). Start it, or set "url" in engines.json.`);
    }
    return res;
  }

  /** Queue a workflow: its prompt_id, or the validation errors in words. */
  async queue(workflow) {
    const res = await this.request('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: this.clientId }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ComfyUI refused the workflow: ${describeErrors(body)}`);
    return body.prompt_id;
  }

  /** Wait for a prompt to finish: its history entry (outputs, status). */
  async wait(promptId, { signal, pollMs = 1000, timeoutMs = 30 * 60_000 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) {
        await this.request('/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt_id: promptId }) }).catch(() => {});
        throw new Error('cancelled');
      }
      const res = await this.request(`/history/${encodeURIComponent(promptId)}`);
      const h = res.ok ? (await res.json())[promptId] : null;
      if (h?.status?.status_str === 'error') throw new Error(`ComfyUI failed: ${executionError(h.status)}`);
      if (h && (h.status?.completed || h.status?.status_str === 'success')) return h;
      if (Date.now() > end) throw new Error('ComfyUI did not finish in time');
      await new Promise((ok) => setTimeout(ok, pollMs));
    }
  }

  /** Upload a file to ComfyUI's input folder (POST /upload/image takes any file): the name LoadAudio uses. */
  async upload(bytes, name) {
    const form = new FormData();
    form.append('image', new Blob([bytes]), name);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const res = await this.request('/upload/image', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`ComfyUI did not take the song's audio (HTTP ${res.status})`);
    const r = await res.json();
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }

  /** Download an output file. */
  async view({ filename, subfolder = '', type = 'output' }) {
    const q = new URLSearchParams({ filename, subfolder, type });
    const res = await this.request(`/view?${q}`);
    if (!res.ok) throw new Error(`Could not download ${filename} from ComfyUI (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** The audio files of a finished prompt: from the chosen node, or the first that has any. */
export function audioOutputs(history, node = null) {
  const outs = history.outputs ?? {};
  const files = (n) =>
    Object.values(outs[n] ?? {})
      .flat()
      .filter((f) => f && typeof f === 'object' && typeof f.filename === 'string' && AUDIO_EXT[path.extname(f.filename).toLowerCase()])
      .map((f) => ({ ...f, format: AUDIO_EXT[path.extname(f.filename).toLowerCase()] }));
  if (node) return files(node);
  for (const n of Object.keys(outs)) {
    const f = files(n);
    if (f.length) return f;
  }
  return [];
}

export const mimeOf = (format) => MIME[format] ?? 'application/octet-stream';

function describeErrors(body) {
  const parts = [];
  if (body.error?.message) parts.push(`${body.error.message}${body.error.details ? ` (${body.error.details})` : ''}`);
  for (const [node, e] of Object.entries(body.node_errors ?? {})) for (const x of e.errors ?? []) parts.push(`node ${node} (${e.class_type}): ${x.message}${x.details ? ` — ${x.details}` : ''}`);
  const text = parts.join('; ') || 'invalid workflow';
  return /missing_node_type|not found|does not exist/i.test(JSON.stringify(body)) ? `${text}. Install the custom nodes this workflow uses.` : text;
}

function executionError(status) {
  const m = (status.messages ?? []).find(([t]) => t === 'execution_error');
  return m ? `${m[1].node_type ?? 'node'} ${m[1].node_id ?? ''}: ${m[1].exception_message ?? 'error'}`.trim() : 'the workflow stopped with an error';
}
