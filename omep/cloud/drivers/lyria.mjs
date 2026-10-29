// Google Lyria through the Gemini API, from ai.google.dev/gemini-api/docs/music-generation (read
// 2026-10-30): POST /v1beta/interactions { model: "lyria-3.5" | "lyria-3-clip-preview", input,
// response_format: { type: "audio" } }, header x-goog-api-key. The audio comes back base64 (MP3 by
// default) inside the answer's steps; where exactly is not fully documented, so every base64 audio part of
// the answer is looked for. Lyria 3.5 makes songs of "a couple of minutes (controllable using prompt)",
// Lyria 3 Clip 30 s. Every output carries a SynthID watermark. (Lyria RealTime, for the live jam, and
// Lyria 2 on Vertex AI are not in this driver yet.)
import { GatewayError, base64ToBytes, lyricsWithMarkers, promptText, scopeTimes, sniffAudio } from '../runtime.mjs';

const TERMS = 'https://ai.google.dev/gemini-api/terms';
const VERIFIED = '2026-10-30';

/** Every base64 audio part of an answer, wherever it is. */
export function audioParts(json) {
  const out = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return void v.forEach(walk);
    const mime = v.mime_type ?? v.mimeType ?? '';
    const data = v.data ?? v.inline_data?.data ?? v.inlineData?.data;
    if (typeof data === 'string' && data.length > 64 && (/^audio\//.test(mime) || v.type === 'audio')) {
      const bytes = base64ToBytes(data);
      if (sniffAudio(bytes)) out.push(bytes);
    }
    for (const k of Object.keys(v)) if (k !== 'data') walk(v[k]);
  };
  walk(json);
  return out;
}

export default {
  id: 'lyria',
  name: 'Google Lyria',
  homepage: 'https://deepmind.google/models/lyria/',
  keyEnv: 'GEMINI_API_KEY',
  base: 'https://generativelanguage.googleapis.com',
  hosts: ['generativelanguage.googleapis.com'],
  concurrency: 2,
  auth: (key) => ({ 'x-goog-api-key': key }),
  defaultModel: 'lyria-3.5',
  models: {
    'lyria-3.5': { name: 'Lyria 3.5', pricing: { unit: 'call', usd: 0.08, estimated: true }, capabilities: { 'music.song': { conditioning: ['text', 'lyrics', 'bpm', 'key'], max_seconds: 240 } } },
    'lyria-3-clip-preview': { name: 'Lyria 3 Clip (30 s)', pricing: { unit: 'call', usd: 0.04, estimated: true }, capabilities: { 'music.add_layer': { conditioning: ['text', 'bpm', 'key'], max_seconds: 30 } } },
  },
  rights() {
    return {
      license: { code: 'Gemini API terms', weights: null, commercial: 'conditional', attribution: null, conditions: 'Check the Gemini API terms for generated music before commercial use; every output carries a SynthID watermark.', url: TERMS },
      output_rights: { commercial: 'conditional', terms_url: TERMS },
    };
  },
  data_policy: { uploads_audio: false, retention: 'as in the Gemini API terms', training_on_inputs: 'unknown', terms_url: TERMS, verified: VERIFIED },

  parseError(status, body) {
    const e = body?.error;
    const msg = e?.message ?? '';
    if (status === 400 && /api key/i.test(msg)) return new GatewayError('auth', 'Lyria', 'Google refused the API key', { status });
    if (status === 401 || status === 403) return new GatewayError('auth', 'Lyria', `Google refused the request${msg ? `: ${msg}` : ''} (Lyria needs a paid Gemini API tier)`, { status });
    if (status === 429) return new GatewayError(/quota/i.test(msg) ? 'credits' : 'rate', 'Lyria', `Google: ${msg || 'too many requests'}`, { status, retryable: !/quota/i.test(msg) });
    if (status === 400 && /safety|blocked|filter/i.test(msg)) return new GatewayError('moderation', 'Lyria', `Google’s safety filters refused the prompt: ${msg}`, { status });
    return null;
  },

  async run({ capability, model, scp, request, http }) {
    const s = scopeTimes(scp);
    const lyrics = capability === 'music.song' ? lyricsWithMarkers(scp, request) : null;
    // Length is controlled through the prompt for Lyria 3.5.
    const length = model === 'lyria-3.5' ? `about ${Math.round(s.seconds)} seconds long` : '';
    const input = [promptText(scp, request) || 'instrumental music', length, lyrics ? `Lyrics:\n${lyrics}` : 'instrumental, no vocals'].filter(Boolean).join('. ');
    const json = await http.json('/v1beta/interactions', { json: { model, input, response_format: { type: 'audio' } }, timeoutMs: 10 * 60_000 });
    const [bytes] = audioParts(json);
    if (!bytes) throw new GatewayError('bad_request', 'Lyria', 'Lyria answered without audio (the prompt may have been filtered)');
    return { files: [{ bytes, role: capability === 'music.song' ? 'full' : 'layer' }], provenance: { prompt: input.slice(0, 2000), ...(json.id ? { request_id: String(json.id) } : {}) }, cost_usd: this.models[model].pricing.usd };
  },
};
