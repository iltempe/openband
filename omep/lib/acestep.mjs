// ACE-Step 1.5 (MIT, code and weights) as an OMEP engine, through the REST server ACE-Step ships
// (`uv run acestep-api`, http://127.0.0.1:8001): submit with POST /release_task, follow with
// POST /query_result (status 0 running, 1 done, 2 failed), download with GET /v1/audio?path=….
// OMEP capabilities map onto ACE-Step's tasks:
//   music.song      → text2music
//   music.add_layer → lego (a new track over the song's audio; base models only)
//   music.repaint   → repaint (the scope regenerated inside its surroundings)
//   music.restyle   → cover (the same part in another style)
// Pure, apart from fetch: the engine process (omep/ace-step-engine.mjs) and the tests use it.
import { decodeWav, encodeWav } from './audio.mjs';

export const ACESTEP_API = 'http://127.0.0.1:8001';
export const ACESTEP_LICENSE = { code: 'MIT', weights: 'MIT', commercial: 'yes', attribution: null, conditions: null, url: 'https://github.com/ACE-Step/ACE-Step-1.5/blob/main/LICENSE' };
/** ACE-Step's own track names for lego. */
export const LEGO_TRACKS = ['vocals', 'backing_vocals', 'drums', 'bass', 'guitar', 'keyboard', 'percussion', 'strings', 'synth', 'fx', 'brass', 'woodwinds'];

const BASE_ONLY = new Set(['music.add_layer']);

/** The manifest for a configured model (acestep-v15-turbo by default; lego needs a base model). */
export function manifestFor(model = 'acestep-v15-turbo') {
  const base = /base/.test(model);
  const caps = {
    'music.song': { conditioning: ['text', 'lyrics', 'bpm', 'key', 'meter'], max_seconds: 600 },
    'music.add_layer': { conditioning: ['text', 'bpm', 'key', 'context_audio'], max_seconds: 600, roles: LEGO_TRACKS },
    'music.repaint': { conditioning: ['text', 'lyrics', 'bpm', 'key', 'context_audio'], max_seconds: 600 },
    'music.restyle': { conditioning: ['text', 'bpm', 'key', 'context_audio'], max_seconds: 600 },
  };
  for (const c of BASE_ONLY) if (!base) delete caps[c];
  return {
    omep: '1.0',
    engine: { id: 'ace-step', name: 'ACE-Step 1.5', version: '1.5.0', homepage: 'https://github.com/ACE-Step/ACE-Step-1.5' },
    license: ACESTEP_LICENSE,
    runtime: { where: 'local', device: ['cuda', 'mps', 'rocm', 'cpu'], vram_gb: 4, realtime: false },
    capabilities: caps,
    outputs: ['audio/wav'],
    languages: ['en', 'it', 'es', 'fr', 'de', 'ja', 'zh', 'ko', 'pt', 'ru'],
    determinism: 'seeded',
  };
}

const bpb = (scp) => Number(String(scp.song?.meter ?? '4/4').split('/')[0]) || 4;
const secondsPerBar = (scp) => (bpb(scp) * 60) / (scp.song?.bpm || 120);

/** The scope in seconds from the song start, and its length. */
export function scopeTimes(scp) {
  const spb = secondsPerBar(scp);
  const from = scp.scope?.from_bar ?? 1;
  const to = scp.scope?.to_bar ?? from + (scp.song?.length_bars ?? 8);
  return { start: (from - 1) * spb, seconds: Math.max(1, (to - from) * spb), bars: to - from };
}

/** "Am" → "A minor", "F#" → "F# major" (ACE-Step's keyscale). */
export function keyScale(key = '') {
  const m = /^([A-G][#b]?)(m)?$/.exec(key.trim());
  return m ? `${m[1]} ${m[2] ? 'minor' : 'major'}` : '';
}

/** The lego track for a request's role, instrument or words. */
export function legoTrack(request = {}) {
  const w = `${request.role ?? ''} ${request.instrument ?? ''} ${request.text ?? ''}`.toLowerCase();
  const pick = [
    [/backing|cori|choir|coro/, 'backing_vocals'],
    [/vocal|voice|voce|sing/, 'vocals'],
    [/perc|shaker|conga|bongo/, 'percussion'],
    [/drum|batter|beat|groove/, 'drums'],
    [/\bbass|basso/, 'bass'],
    [/guitar|chitarr/, 'guitar'],
    [/string|archi|violin|cello/, 'strings'],
    [/brass|horn|trumpet|tromb|ottoni/, 'brass'],
    [/flute|sax|clarinet|woodwind|flauto|legni/, 'woodwinds'],
    [/synth|lead|pad|arp/, 'synth'],
    [/\bfx\b|riser|sweep|effect/, 'fx'],
    [/piano|keys|rhodes|organ|tastier|keyboard/, 'keyboard'],
  ];
  return pick.find(([re]) => re.test(w))?.[1] ?? 'keyboard';
}

/** The words for ACE-Step's caption: the request, the style, the intent. */
function caption(scp, request) {
  const parts = [request.text, request.style, scp.intent?.text, ...(scp.constraints?.soft?.style ?? [])].filter(Boolean);
  return [...new Set(parts)].join(', ').slice(0, 512);
}

/** Lyrics as ACE-Step wants them: the lines, or [Instrumental]. */
function lyricsOf(scp, request) {
  if (typeof request.lyrics === 'string' && request.lyrics.trim()) return request.lyrics.slice(0, 4096);
  const lines = (scp.lyrics?.lines ?? []).map((l) => l.text).filter(Boolean);
  return lines.length ? lines.join('\n').slice(0, 4096) : '[Instrumental]';
}

/**
 * The fields of POST /release_task for an OMEP request. ctx: where the context audio sits, in seconds
 * from the song start ({ start }), when the capability uses it.
 */
export function taskFor(capability, scp, request = {}, seed = 1, ctx = null) {
  const s = scopeTimes(scp);
  const common = {
    prompt: caption(scp, request),
    bpm: scp.song?.bpm ? Math.round(scp.song.bpm) : undefined,
    key_scale: keyScale(scp.song?.key),
    time_signature: String(bpb(scp)),
    seed,
    use_random_seed: false,
    batch_size: 1,
    audio_format: 'wav',
    thinking: false,
    vocal_language: scp.lyrics?.language ?? 'en',
  };
  switch (capability) {
    case 'music.song':
      return { ...common, task_type: 'text2music', lyrics: lyricsOf(scp, request), audio_duration: Math.min(600, Math.max(10, Math.round(s.seconds))) };
    case 'music.add_layer': {
      const track = legoTrack(request);
      return { ...common, task_type: 'lego', instruction: `Generate the ${track} track based on the audio context:`, repainting_start: 0, repainting_end: -1 };
    }
    case 'music.repaint': {
      const at = ctx ? Math.max(0, s.start - ctx.start) : 0;
      return { ...common, task_type: 'repaint', lyrics: lyricsOf(scp, request), repainting_start: +at.toFixed(3), repainting_end: +(at + s.seconds).toFixed(3), chunk_mask_mode: 'explicit' };
    }
    case 'music.restyle':
      return { ...common, task_type: 'cover', audio_cover_strength: typeof request.strength === 'number' ? request.strength : 0.5 };
    default:
      throw new Error(`ACE-Step can't do ${capability}`);
  }
}

/** The part of the answer that is the scope: from `at` seconds, `seconds` long (WAV in, WAV out). */
export function trimWav(bytes, at, seconds) {
  const { sampleRate, channels } = decodeWav(Buffer.from(bytes));
  const from = Math.max(0, Math.round(at * sampleRate));
  const to = Math.min(channels[0].length, from + Math.round(seconds * sampleRate));
  return encodeWav(channels.map((c) => c.subarray(from, to)), sampleRate);
}

/** ACE-Step's REST API. base: its address; key: ACESTEP_API_KEY when the server has one. */
export class AceStepApi {
  constructor({ base = ACESTEP_API, key = null, fetch: f = globalThis.fetch } = {}) {
    this.base = base.replace(/\/$/, '');
    this.key = key;
    this.fetch = f;
  }
  headers(extra = {}) {
    return { ...(this.key ? { authorization: `Bearer ${this.key}` } : {}), ...extra };
  }
  async json(res, what) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    if (!res.ok) throw new Error(`ACE-Step ${what}: HTTP ${res.status}${body?.detail ? ` — ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)}` : ''}`);
    if (body?.error) throw new Error(`ACE-Step ${what}: ${body.error}`);
    return body;
  }
  /** Submit; with audio (WAV bytes) it goes as the src_audio upload. Answers the task id. */
  async submit(fields, audio = null, signal) {
    let res;
    if (audio) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') form.append(k, String(v));
      form.append('src_audio', new Blob([audio], { type: 'audio/wav' }), 'context.wav');
      res = await this.fetch(`${this.base}/release_task`, { method: 'POST', headers: this.headers(), body: form, signal });
    } else res = await this.fetch(`${this.base}/release_task`, { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(fields), signal });
    const body = await this.json(res, 'submit');
    const id = body?.data?.task_id;
    if (!id) throw new Error('ACE-Step answered without a task id');
    return id;
  }
  /** One look at a task: { status: 0|1|2, file?, seed?, error? }. */
  async query(id, signal) {
    const res = await this.fetch(`${this.base}/query_result`, { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ task_id_list: [id] }), signal });
    const body = await this.json(res, 'query');
    const item = (Array.isArray(body?.data) ? body.data : []).find((d) => !d.task_id || d.task_id === id) ?? body?.data?.[0];
    if (!item) return { status: 0 };
    let result = item.result;
    if (typeof result === 'string')
      try {
        result = JSON.parse(result);
      } catch {
        result = null;
      }
    const first = Array.isArray(result) ? result[0] : result;
    const seed = Number.parseInt(String(first?.seed_value ?? '').split(',')[0], 10);
    return { status: Number(item.status ?? first?.status ?? 0), file: first?.file, seed: Number.isFinite(seed) ? seed : undefined, error: item.error ?? first?.error };
  }
  async download(file, signal) {
    const url = /^https?:/.test(file) ? file : `${this.base}${file.startsWith('/') ? '' : '/'}${file}`;
    const res = await this.fetch(url, { headers: this.headers(), signal });
    if (!res.ok) throw new Error(`ACE-Step download: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  /** Submit, follow until done, download. */
  async run(fields, audio, { signal, pollMs = 1000, onStatus } = {}) {
    const id = await this.submit(fields, audio, signal);
    for (;;) {
      if (signal?.aborted) throw new Error('cancelled');
      const q = await this.query(id, signal);
      onStatus?.(q.status);
      if (q.status === 2) throw new Error(`ACE-Step failed${q.error ? `: ${q.error}` : ''}`);
      if (q.status === 1) {
        if (!q.file) throw new Error('ACE-Step finished without a file');
        return { bytes: await this.download(q.file, signal), seed: q.seed, id };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
