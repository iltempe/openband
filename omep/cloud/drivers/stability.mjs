// Stable Audio (Stability AI), from docs.stability.ai/api-reference (read 2026-10-30):
//   POST /v2beta/audio/stable-audio-2/text-to-audio | audio-to-audio | inpaint   multipart, synchronous → audio bytes
//   POST /v2beta/audio/stable-audio/text-to-audio (stable-audio-3)               202 { id } → GET /v2beta/audio/results/{id}
// Auth: Authorization: Bearer. Prompts in English only; uploaded audio recognised as copyrighted is refused.
import { GatewayError, contextAudio, pollUntil, promptText, scopeTimes } from '../runtime.mjs';

const VERIFIED = '2026-10-30';
const PRICE = { unit: 'call', usd: 0.08, verified: VERIFIED };

export default {
  id: 'stability',
  name: 'Stable Audio',
  homepage: 'https://stability.ai/stable-audio',
  keyEnv: 'STABILITY_API_KEY',
  base: 'https://api.stability.ai',
  hosts: ['api.stability.ai'],
  concurrency: 4,
  auth: (key) => ({ authorization: `Bearer ${key}` }),
  defaultModel: 'stable-audio-2.5',
  models: {
    'stable-audio-2.5': {
      name: 'Stable Audio 2.5',
      pricing: PRICE,
      capabilities: {
        'music.song': { conditioning: ['text', 'bpm', 'key'], max_seconds: 190 },
        'music.add_layer': { conditioning: ['text', 'bpm', 'key'], max_seconds: 190 },
        'music.restyle': { conditioning: ['text', 'context_audio'], max_seconds: 190 },
        'music.repaint': { conditioning: ['text', 'context_audio', 'bpm', 'key'], max_seconds: 190 },
      },
    },
    'stable-audio-3': {
      name: 'Stable Audio 3',
      pricing: PRICE,
      capabilities: {
        'music.song': { conditioning: ['text', 'bpm', 'key'], max_seconds: 380 },
        'music.add_layer': { conditioning: ['text', 'bpm', 'key'], max_seconds: 380 },
      },
    },
  },
  rights() {
    // ToS §4(a): the user owns the outputs; §3(b)(9–10): don't present them as human-made, keep provenance.
    return {
      license: { code: 'Stability AI API terms', weights: null, commercial: 'conditional', attribution: null, conditions: 'Don’t present the output as human-made, and keep its provenance (Stability AI terms §3(b)); you own it (§4(a)).', url: 'https://stability.ai/terms-of-service' },
      output_rights: { commercial: 'yes', terms_url: 'https://stability.ai/terms-of-service' },
    };
  },
  data_policy: { uploads_audio: true, retention: 'results kept 24 h (Stable Audio 3); inputs and outputs may train Stability’s models unless you opt out (terms §4(c))', training_on_inputs: 'yes', terms_url: 'https://stability.ai/terms-of-service', verified: VERIFIED },

  parseError(status, body) {
    const name = body?.name;
    const msg = Array.isArray(body?.errors) ? body.errors.join('; ') : '';
    if (name === 'content_moderation') return new GatewayError('moderation', 'Stable Audio', `Stable Audio's moderation flagged the request (not charged)${msg ? `: ${msg}` : ''}`, { status, requestId: body?.id });
    if (name === 'invalid_language') return new GatewayError('language', 'Stable Audio', 'Stable Audio takes English prompts only: describe the sound in English', { status, requestId: body?.id });
    if (name === 'copyrighted_content') return new GatewayError('copyright', 'Stable Audio', 'Stable Audio recognised copyrighted content in the song’s audio and refused it', { status, requestId: body?.id });
    if (status === 402) return new GatewayError('credits', 'Stable Audio', 'Your Stability account is out of credits', { status });
    if (status === 401) return new GatewayError('auth', 'Stable Audio', 'Stability refused the API key', { status });
    if (status === 429) return new GatewayError('rate', 'Stable Audio', 'Too many requests to Stability (150 every 10 s)', { status, retryable: true });
    if (status === 413) return new GatewayError('bad_request', 'Stable Audio', 'The song’s audio is too large for Stability (50 MB at most)', { status });
    return null;
  },

  async run({ capability, model, scp, request, seed, http, signal, progress }) {
    const s = scopeTimes(scp);
    const max = this.models[model].capabilities[capability].max_seconds;
    const duration = Math.min(max, Math.max(1, Math.round(s.seconds)));
    const prompt = promptText(scp, request) || 'instrumental music';
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('output_format', 'wav');
    if (seed) form.append('seed', String(seed >>> 0));
    if (model === 'stable-audio-3') {
      form.append('model', model);
      form.append('duration', String(duration));
      const r = await http.request('/v2beta/audio/stable-audio/text-to-audio', { method: 'POST', body: form, headers: { accept: 'application/json' }, accept: [202] });
      const { id } = await r.json();
      const bytes = await pollUntil(
        async () => {
          const res = await http.request(`/v2beta/audio/results/${id}`, { headers: { accept: 'audio/*' }, accept: [202] });
          if (res.status === 202) return { done: false, note: 'generating' };
          return { done: true, value: new Uint8Array(await res.arrayBuffer()) };
        },
        { everyMs: 2000, signal, onProgress: () => progress?.('Stable Audio is generating') },
      );
      return { files: [{ bytes, role: capability === 'music.song' ? 'full' : 'layer' }], provenance: { prompt, request_id: id }, cost_usd: 0.08 };
    }
    form.append('model', 'stable-audio-2.5');
    let path = '/v2beta/audio/stable-audio-2/text-to-audio';
    if (capability === 'music.restyle' || capability === 'music.repaint') {
      const ctx = await contextAudio(scp);
      if (!ctx) throw new GatewayError('bad_request', 'Stable Audio', `${capability} needs the song's audio`);
      form.append('audio', new Blob([ctx.bytes], { type: `audio/${ctx.format === 'mp3' ? 'mpeg' : 'wav'}` }), `song.${ctx.format}`);
      if (capability === 'music.restyle') {
        path = '/v2beta/audio/stable-audio-2/audio-to-audio';
        // OpenBand's strength is "how close to the original"; Stability's is "how far from it" (0 = identical).
        const close = Number.isFinite(request.strength) ? request.strength : 0.5;
        form.append('strength', String(Math.min(1, Math.max(0.01, 1 - close)).toFixed(2)));
        form.append('duration', String(Math.min(190, duration)));
      } else {
        path = '/v2beta/audio/stable-audio-2/inpaint';
        const at = Math.max(0, s.start - (ctx.fromBar - 1) * (s.seconds / s.bars));
        form.append('mask_start', at.toFixed(2));
        form.append('mask_end', Math.min(190, at + s.seconds).toFixed(2));
        form.append('duration', String(Math.min(190, Math.ceil(at + s.seconds))));
      }
    } else form.append('duration', String(duration));
    const { bytes, headers } = await http.bytes(path, { method: 'POST', body: form, headers: { accept: 'audio/*' } });
    return {
      files: [{ bytes, role: capability === 'music.song' || capability === 'music.restyle' ? 'full' : 'layer' }],
      provenance: { prompt, request_id: headers.get('x-request-id') ?? undefined, seed: Number(headers.get('seed')) || seed },
      cost_usd: 0.08,
    };
  },
};
