// fal.ai as OMEP engines (SPEC v0.6 §9-bis): a model of omep/fal-catalog.json → its OMEP manifest, the
// request it takes for a Song Context Package, its price, and fal's queue (submit → status → result,
// cancel) as documented at fal.ai/docs (verified 2026-10-25). Runs in Node (omep/fal-engine.mjs, with the
// user's key) and in the browser (through the user's relay, deploy/relay/, which adds the key — the
// browser never holds it). No SDK: fetch only.

export const FAL_QUEUE = 'https://queue.fal.run';

/** The OMEP manifest of one catalog model. */
export function manifestFor(model, verified) {
  return {
    omep: '1.0',
    engine: { id: `fal-${model.id}`, name: model.name, version: '1.0.0', homepage: model.homepage },
    license: model.license,
    runtime: {
      where: 'cloud',
      provider: 'fal',
      realtime: false,
      // A price fal doesn't publish is an estimate: not marked as verified.
      pricing: { unit: model.price.unit, usd: model.price.usd, ...(model.price.estimated ? {} : { verified }) },
      data_policy: { ...model.data_policy, verified },
      output_rights: model.output_rights,
    },
    capabilities: model.capabilities,
    outputs: ['audio/wav'],
    languages: ['en', 'it'],
    determinism: model.input && Object.values(model.input).some((v) => String(v).includes('{seed}')) ? 'seeded' : 'stochastic',
  };
}

/** Seconds of music the scope asks for (4/4 unless the meter says otherwise). */
export function scopeSeconds(scp) {
  const beatsPerBar = Number(String(scp.song?.meter ?? '4/4').split('/')[0]) || 4;
  const from = scp.scope?.from_bar ?? 1;
  const to = scp.scope?.to_bar ?? from + (scp.song?.length_bars ?? 8);
  return Math.max(1, ((to - from) * beatsPerBar * 60) / (scp.song?.bpm ?? 120));
}

/** What the run will cost, before running it (USD): per second of output, or of input for separation. */
export function quote(model, scp, request = {}) {
  const seconds = Number(request.seconds) || scopeSeconds(scp);
  const usd = model.price.unit === 'second' ? seconds * model.price.usd : model.price.usd;
  return Math.round(usd * 1e6) / 1e6;
}

const lyricsOf = (scp) => {
  const lines = (scp.lyrics?.lines ?? []).map((l) => l.text).filter(Boolean);
  return lines.length ? lines.join('\n') : '[inst]';
};

/** The model's input for this request: the catalog's templates filled in (whole numbers stay numbers). */
export function inputFor(model, scp, request = {}, seed) {
  const words = [request.text, request.style, scp.intent?.text, scp.intent?.instrument, ...(scp.constraints?.soft?.style ?? [])].filter(Boolean).join(', ') || 'instrumental';
  const values = {
    text: words,
    lyrics: request.lyrics ?? lyricsOf(scp),
    seconds: Math.round(Number(request.seconds) || scopeSeconds(scp)),
    bpm: Math.round(scp.song?.bpm ?? 120),
    key: scp.song?.key ? `${scp.song.key.replace(/m$/, '')} ${/m$/.test(scp.song.key) ? 'minor' : 'major'}` : '',
    seed: seed ?? 1,
    audio: request.audio_url ?? scp.context_audio?.mix_uri ?? '',
    // What the original sounds like, for models that ask (a cover's starting point).
    original: request.original ?? (scp.constraints?.soft?.original_style ?? 'original recording'),
  };
  const out = {};
  for (const [k, tpl] of Object.entries(model.input ?? {})) {
    if (typeof tpl !== 'string') {
      out[k] = tpl;
      continue;
    }
    const whole = tpl.match(/^\{(\w+)\}$/);
    if (whole) {
      const v = values[whole[1]];
      if (v !== '' && v !== undefined) out[k] = v;
      continue;
    }
    out[k] = tpl.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')).replace(/(,\s*)+$/, '').replace(/^,\s*/, '');
  }
  return out;
}

/** A value at a dotted path ("audio.url"). */
export const pick = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** The files a model's answer holds: [{role, url}]. */
export function outputsOf(model, json) {
  const out = [];
  for (const [role, spec] of Object.entries(model.output ?? {})) {
    if (typeof spec === 'string') {
      const url = pick(json, spec);
      if (url) out.push({ role, url });
    } else for (const [stem, p] of Object.entries(spec)) {
      const url = pick(json, p);
      if (url) out.push({ role: stem, url });
    }
  }
  return out;
}

/**
 * fal's queue. `base` is fal itself (with `key`) or the user's relay (with its `token`): the URLs fal
 * hands back are rewritten to go through the same base.
 */
export class FalQueue {
  constructor({ base = FAL_QUEUE, key = null, token = null, fetch: f = globalThis.fetch } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.key = key;
    this.token = token;
    this.fetch = f;
  }

  headers() {
    return { 'content-type': 'application/json', ...(this.key ? { authorization: `Key ${this.key}` } : {}), ...(this.token ? { 'x-relay-token': this.token } : {}) };
  }

  /** A queue URL from fal, through our base (the relay, or fal). */
  via(url) {
    return this.base === FAL_QUEUE ? url : url.replace(/^https:\/\/queue\.fal\.run/, this.base);
  }

  async json(res, what) {
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { detail: text.slice(0, 200) };
    }
    if (!res.ok && !(what === 'cancel' && (res.status === 202 || res.status === 400 || res.status === 404))) {
      const why = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body).slice(0, 200);
      throw new Error(res.status === 401 || res.status === 403 ? `fal refused the key (HTTP ${res.status})` : `fal ${what}: HTTP ${res.status} ${why}`);
    }
    return body;
  }

  async submit(endpoint, input) {
    const res = await this.fetch(`${this.base}/${endpoint}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(input) });
    const body = await this.json(res, 'submit');
    if (!body.request_id || !body.status_url || !body.response_url) throw new Error('fal submit: unexpected answer (no request_id / status_url / response_url)');
    return body;
  }

  async status(req) {
    return this.json(await this.fetch(this.via(req.status_url), { headers: this.headers() }), 'status');
  }

  async result(req) {
    return this.json(await this.fetch(this.via(req.response_url), { headers: this.headers() }), 'result');
  }

  async cancel(req) {
    const url = req.cancel_url ?? req.response_url.replace(/\/?$/, '/cancel');
    return this.json(await this.fetch(this.via(url), { method: 'PUT', headers: this.headers() }), 'cancel');
  }

  /**
   * Submit and wait for the answer. onStatus({status, queue_position}) on every poll; an aborted signal
   * cancels the request at fal. COMPLETED with an error is a failure.
   */
  async run(endpoint, input, { signal, onStatus, pollMs = 1000, timeoutMs = 15 * 60_000 } = {}) {
    const req = await this.submit(endpoint, input);
    const t0 = Date.now();
    for (;;) {
      if (signal?.aborted) {
        await this.cancel(req).catch(() => {});
        throw new Error('cancelled');
      }
      if (Date.now() - t0 > timeoutMs) {
        await this.cancel(req).catch(() => {});
        throw new Error(`fal did not finish in ${Math.round(timeoutMs / 1000)} s`);
      }
      const s = await this.status(req);
      onStatus?.(s);
      if (s.status === 'COMPLETED') {
        if (s.error) throw new Error(`fal: ${s.error}${s.error_type ? ` (${s.error_type})` : ''}`);
        return this.result(req);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

/**
 * Context audio for a model: fal documents no REST upload to its CDN, only public or presigned URLs and
 * data URIs for small files. Data URIs up to this size; beyond it the caller must pass an https URL.
 */
export const MAX_DATA_URI_BYTES = 8 * 1024 * 1024;
export function dataUri(bytes, mime = 'audio/wav') {
  if (bytes.length > MAX_DATA_URI_BYTES) throw new Error(`The audio (${(bytes.length / 1048576).toFixed(1)} MB) is too large to send inline to fal (max ${MAX_DATA_URI_BYTES / 1048576} MB): use a shorter range`);
  let b64;
  if (typeof Buffer !== 'undefined') b64 = Buffer.from(bytes).toString('base64');
  else {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    b64 = btoa(s);
  }
  return `data:${mime};base64,${b64}`;
}
