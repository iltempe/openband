// Mureka, from platform.mureka.ai/docs (the operation pages, rendered, read 2026-10-30):
//   POST /v1/song/generate        { lyrics (required, ≤5000), model, n (default 2, max 3: each song is charged),
//                                   prompt (≤1024), gender, duration [120,300] (mureka-9.5 only), … } → task
//   POST /v1/instrumental/generate { model, n, prompt } → task
//   GET  /v1/song/query/{id} | /v1/instrumental/query/{id} → { status: preparing|queued|running|streaming|
//        succeeded|failed|timeouted|cancelled, failed_reason, choices: [{ id, url, flac_url, wav_url (30 days),
//        duration (ms), lyrics_sections: [{ section_type, start, end, lines: [{ start, end, text, words }] }] }] }
// Auth: Authorization: Bearer. Errors: { error: { message }, trace_id }.
import { GatewayError, lyricsWithMarkers, pollUntil, promptText, scopeTimes } from '../runtime.mjs';

const VERIFIED = '2026-10-30';
const TERMS = 'https://platform.mureka.ai/docs/en/faq.html';
const SONG_MODELS = ['auto', 'mureka-7.6', 'mureka-o2', 'mureka-8', 'mureka-9', 'mureka-9.5'];
const INSTR_MODELS = ['auto', 'mureka-7.6', 'mureka-8', 'mureka-9', 'mureka-9.5'];
// The API's prices are not published (a prepaid balance): an estimate, marked as such.
const PRICE = { unit: 'track', usd: 0.05, estimated: true };
const DONE = new Set(['succeeded', 'failed', 'timeouted', 'cancelled']);

export default {
  id: 'mureka',
  name: 'Mureka',
  homepage: 'https://platform.mureka.ai',
  keyEnv: 'MUREKA_API_KEY',
  base: 'https://api.mureka.ai',
  hosts: ['api.mureka.ai'],
  concurrency: 5,
  auth: (key) => ({ authorization: `Bearer ${key}` }),
  defaultModel: 'auto',
  models: Object.fromEntries(
    SONG_MODELS.map((m) => [
      m,
      {
        name: m === 'auto' ? 'Mureka (latest)' : `Mureka ${m.replace('mureka-', '')}`,
        pricing: PRICE,
        capabilities: {
          'music.song': { conditioning: ['text', 'lyrics', 'sections', 'bpm', 'key'], max_seconds: 300 },
          ...(INSTR_MODELS.includes(m) ? { 'music.add_layer': { conditioning: ['text', 'bpm', 'key'], max_seconds: 300 } } : {}),
        },
      },
    ]),
  ),
  rights() {
    return {
      license: { code: 'Mureka API terms', weights: null, commercial: 'yes', attribution: null, conditions: 'Content from paid API calls comes with full usage rights and commercial authorization (Mureka FAQ).', url: TERMS },
      output_rights: { commercial: 'yes', terms_url: TERMS },
    };
  },
  data_policy: { uploads_audio: false, retention: 'song URLs valid for 30 days', training_on_inputs: 'unknown', terms_url: TERMS, verified: VERIFIED },

  parseError(status, body) {
    const msg = body?.error?.message ?? '';
    const requestId = body?.trace_id;
    if (status === 401) return new GatewayError('auth', 'Mureka', 'Mureka refused the API key', { status, requestId });
    if (status === 403) return new GatewayError('region', 'Mureka', 'Mureka is not available from this region', { status, requestId });
    if (status === 429 && /quota|credit|billing/i.test(msg)) return new GatewayError('credits', 'Mureka', 'Your Mureka API balance is used up: top it up on platform.mureka.ai', { status, requestId });
    if (status === 429) return new GatewayError('rate', 'Mureka', 'Mureka: more songs at once than your plan’s concurrency', { status, retryable: true, requestId });
    if (status === 503) return new GatewayError('unavailable', 'Mureka', 'Mureka’s engine is overloaded: retrying', { status, retryable: true, requestId });
    if (status === 400) return new GatewayError('bad_request', 'Mureka', `Mureka refused the request${msg ? `: ${msg}` : ''}`, { status, requestId });
    return null;
  },

  async run({ capability, model, scp, request, http, signal, progress }) {
    const s = scopeTimes(scp);
    const prompt = promptText(scp, request).slice(0, 1024);
    const lyrics = capability === 'music.song' ? lyricsWithMarkers(scp, request) : null;
    const instrumental = !lyrics;
    const m = instrumental && !INSTR_MODELS.includes(model) ? 'auto' : model;
    // n: 1 — Mureka's default is 2, and every song is charged.
    const body = instrumental
      ? { model: m, n: 1, prompt: prompt || 'instrumental' }
      : { model: m, n: 1, lyrics: lyrics.slice(0, 5000), ...(prompt ? { prompt } : {}), ...(m === 'mureka-9.5' && s.seconds >= 120 && s.seconds <= 300 ? { duration: Math.round(s.seconds) } : {}), ...(request.gender ? { gender: request.gender } : {}) };
    const kind = instrumental ? 'instrumental' : 'song';
    const task = await http.json(`/v1/${kind}/generate`, { json: body });
    const done = await pollUntil(
      async () => {
        const t = await http.json(`/v1/${kind}/query/${encodeURIComponent(task.id)}`, { method: 'GET' });
        if (!DONE.has(t.status)) return { done: false, note: t.status };
        return { done: true, value: t };
      },
      { everyMs: 3000, signal, onProgress: (r) => progress?.(`Mureka: ${r.note}`) },
    );
    if (done.status !== 'succeeded') throw new GatewayError(done.status === 'timeouted' ? 'timeout' : 'bad_request', 'Mureka', `Mureka ${done.status}${done.failed_reason ? `: ${done.failed_reason}` : ''}`, { requestId: task.trace_id ?? task.id });
    const c = done.choices?.[0];
    const url = c?.wav_url ?? c?.flac_url ?? c?.url;
    if (!url) throw new GatewayError('bad_request', 'Mureka', 'Mureka finished without a song');
    // The song's own CDN, not the API: no key on that request.
    const { bytes } = await http.bytes(url, { auth: false, anyHost: true });
    // Word timings: the lyrics as sung, for aligning them in the studio.
    const words = (c.lyrics_sections ?? []).flatMap((sec) => (sec.lines ?? []).flatMap((l) => (l.words?.length ? l.words : [{ text: l.text, start: l.start, end: l.end }]))).filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
    return {
      files: [{ bytes, role: capability === 'music.song' ? 'full' : 'layer' }],
      provenance: { prompt: [prompt, lyrics ? `lyrics: ${lyrics.length} characters` : 'instrumental'].filter(Boolean).join(' · '), request_id: String(task.id) },
      ...(words.length ? { alignment: { syllables: words.map((w) => ({ text: String(w.text), start_ms: Math.max(0, w.start), end_ms: Math.max(0, w.end) })) } } : {}),
      cost_usd: PRICE.usd,
    };
  },
};
