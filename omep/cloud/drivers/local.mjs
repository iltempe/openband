// Any music model server on this computer or the LAN, without writing an adapter: what to call and where
// the audio is in the answer, declared in engines.json. For a model that has an HTTP API of its own (a
// MusicGen or Stable Audio Open server, a Gradio-free FastAPI wrapper, the user's own script…):
//
//   "musicgen": { "builtin": "omep-cloud", "provider": "local", "name": "MusicGen on my PC",
//     "base_url": "http://127.0.0.1:9000",
//     "license": { "code": "MIT", "weights": "CC-BY-NC-4.0", "commercial": "no", "attribution": null, "conditions": null },
//     "capabilities": {
//       "music.add_layer": {
//         "request": { "method": "POST", "path": "/generate",
//                      "body": { "prompt": "{text}, {bpm} bpm, {key}", "duration": "{seconds}", "seed": "{seed}" } },
//         "response": { "audio": "$bytes" }                           // the answer is the audio itself
//         // or { "audio_url": "result.url" } / { "audio_base64": "audio" }  (paths in a JSON answer)
//         // queued: "poll": { "id": "job_id", "path": "/jobs/{id}", "done": "status=done", "failed": "status=error",
//         //                   "audio_url": "result.url" }
//       } } }
//
// Values: {text} {lyrics} {seconds} {bpm} {key} {seed} {meter} {title}. A key, if the server wants one,
// goes in "env" (LOCAL_API_KEY) and is sent as "auth_header" (default Authorization: Bearer).
import { GatewayError, base64ToBytes, contextAudio, lyricsWithMarkers, pollUntil, promptText, scopeTimes, styleText, keyWords } from '../runtime.mjs';

const pick = (obj, p) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** A template with the song's values: "{text}, {bpm} bpm" → "warm piano, 92 bpm"; "{seconds}" alone stays a number. */
export function fill(tpl, values) {
  if (typeof tpl === 'string') {
    const whole = /^\{(\w+)\}$/.exec(tpl);
    if (whole) return values[whole[1]];
    return tpl.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? '')).replace(/(,\s*)+$/, '').replace(/^\s*,\s*/, '');
  }
  if (Array.isArray(tpl)) return tpl.map((x) => fill(x, values));
  if (tpl && typeof tpl === 'object') return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fill(v, values)]).filter(([, v]) => v !== undefined && v !== ''));
  return tpl;
}

const matches = (json, cond) => {
  if (!cond) return false;
  const [p, want] = String(cond).split('=');
  const v = pick(json, p);
  return want === undefined ? !!v : String(v) === want;
};

export default {
  id: 'local',
  name: 'Local model server',
  homepage: 'https://github.com/iltempe/openband/blob/main/docs/ENSEMBLE.md',
  keyEnv: 'LOCAL_API_KEY',
  base: null, // from "base_url"
  hosts: null, // only base_url's host (set by the engine)
  concurrency: 1,
  auth: (key, config) => (key ? { [config.auth_header ?? 'authorization']: config.auth_header ? key : `Bearer ${key}` } : {}),
  defaultModel: 'default',
  /** The models a configuration declares: one, named after it. */
  modelsFor(config) {
    const caps = {};
    for (const [cap, c] of Object.entries(config.capabilities ?? {})) caps[cap] = { conditioning: c.conditioning ?? ['text', 'bpm', 'key'], ...(c.max_seconds ? { max_seconds: c.max_seconds } : {}) };
    return { default: { name: config.name ?? 'Local model', capabilities: caps, pricing: null } };
  },
  rights(_plan, config) {
    return { license: config.license ?? { code: 'unknown', weights: null, commercial: 'conditional', attribution: null, conditions: 'Declare the licence of this model ("license" in engines.json): the release checks depend on it.' } };
  },
  data_policy: null,

  async run({ capability, scp, request, seed, http, signal, progress, config }) {
    const spec = config.capabilities?.[capability];
    if (!spec?.request) throw new GatewayError('bad_request', config.name ?? 'Local model', `No "request" for ${capability} in engines.json`);
    const s = scopeTimes(scp);
    const ctx = /\{audio\}/.test(JSON.stringify(spec.request)) ? await contextAudio(scp) : null;
    const values = {
      text: styleText(scp, request) || 'instrumental',
      prompt: promptText(scp, request),
      lyrics: lyricsWithMarkers(scp, request) ?? '',
      seconds: Math.round(s.seconds),
      bpm: Math.round(scp.song?.bpm ?? 120),
      key: keyWords(scp.song?.key),
      meter: scp.song?.meter ?? '4/4',
      title: scp.song?.title ?? '',
      seed: seed ?? 1,
      audio: ctx ? `data:audio/${ctx.format};base64,${Buffer.from(ctx.bytes).toString('base64')}` : undefined,
    };
    const r = spec.request;
    const body = r.body !== undefined ? fill(r.body, values) : undefined;
    const res = await http.request(fill(r.path ?? '/', values), { method: r.method ?? 'POST', ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}), timeoutMs: (spec.timeout_s ?? 600) * 1000 });
    const out = spec.response ?? { audio: '$bytes' };
    const grab = async (json, where) => {
      if (where.audio_base64) return base64ToBytes(pick(json, where.audio_base64));
      if (where.audio_url) {
        const url = new URL(String(pick(json, where.audio_url)), http.base);
        return (await http.bytes(url.href)).bytes;
      }
      throw new GatewayError('bad_request', config.name ?? 'Local model', 'engines.json: say where the audio is ("audio", "audio_url" or "audio_base64")');
    };
    let bytes;
    if (out.audio === '$bytes' && !spec.poll) bytes = new Uint8Array(await res.arrayBuffer());
    else {
      const json = await res.json();
      if (spec.poll) {
        const id = pick(json, spec.poll.id);
        const done = await pollUntil(
          async () => {
            const j = await http.json(fill(spec.poll.path, { ...values, id }), { method: 'GET' });
            if (matches(j, spec.poll.failed)) throw new GatewayError('bad_request', config.name ?? 'Local model', `The model failed: ${JSON.stringify(j).slice(0, 300)}`);
            return matches(j, spec.poll.done) ? { done: true, value: j } : { done: false };
          },
          { everyMs: (spec.poll.every_s ?? 2) * 1000, signal, onProgress: () => progress?.(`${config.name ?? 'The model'} is working`) },
        );
        bytes = await grab(done, spec.poll);
      } else bytes = await grab(json, out);
    }
    return { files: [{ bytes, role: spec.role ?? (capability === 'music.song' ? 'full' : 'layer') }], provenance: { prompt: values.text } };
  },
};
