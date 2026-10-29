// ElevenLabs Music, from elevenlabs.io/docs (read 2026-10-30): POST /v1/music?output_format=…, header
// xi-api-key, JSON, synchronous (the audio comes back in the response). The song's sections become a
// composition plan — each section its own length, styles and lyric lines — so the parts come back as long
// as the arrangement needs. Rights depend on the user's plan (Music Terms, Exhibit A, 9 Oct 2026), which
// the user declares in engines.json ("plan"); without it they are recorded as "check your plan".
import { GatewayError, promptRisks, promptText, scopeTimes, sectionsInScope, styleText, keyWords } from '../runtime.mjs';

const VERIFIED = '2026-10-30';
const TERMS = 'https://elevenlabs.io/music-terms';
// ~900 credits per minute; a credit's price depends on the plan (Creator: $22 for 121k credits ≈ $0.16/min).
const PRICE = { unit: 'minute', usd: 0.16, estimated: true };
const MUSIC_CAPS = {
  'music.song': { conditioning: ['text', 'lyrics', 'sections', 'bpm', 'key'], max_seconds: 600 },
  'music.add_layer': { conditioning: ['text', 'sections', 'bpm', 'key'], max_seconds: 600 },
};

/** What the plan allows (Exhibit A of the Music Terms). */
const PLANS = {
  free: { commercial: 'conditional', attribution: 'Music made with Eleven Music (ElevenLabs)', conditions: 'Free plan: no API access, attribution required, no distribution to streaming services, individual use only.' },
  starter: { commercial: 'conditional', conditions: 'Starter plan: commercial use except film, TV, radio and studio games; distribution to streaming services is NOT allowed; individual use only.' },
  creator: { commercial: 'conditional', conditions: 'Creator plan: commercial use except film, TV, radio and studio games; individual use only.' },
  pro: { commercial: 'conditional', conditions: 'Pro plan: commercial use except film, TV, radio and studio games; individual use only.' },
  scale: { commercial: 'conditional', conditions: 'Scale plan: commercial use except film, TV, radio and studio games; companies under 10 employees.' },
  business: { commercial: 'conditional', conditions: 'Business plan: commercial use except film, TV, radio and studio games; companies under 50 employees.' },
  enterprise: { commercial: 'yes' },
};

export default {
  id: 'elevenlabs',
  name: 'ElevenLabs Music',
  homepage: 'https://elevenlabs.io/music',
  keyEnv: 'ELEVENLABS_API_KEY',
  base: 'https://api.elevenlabs.io',
  hosts: ['api.elevenlabs.io', 'api.us.elevenlabs.io', 'api.eu.residency.elevenlabs.io', 'api.in.residency.elevenlabs.io', 'api.sg.residency.elevenlabs.io'],
  // Two generations at once on Starter, Creator and Pro.
  concurrency: 2,
  auth: (key) => ({ 'xi-api-key': key }),
  defaultModel: 'music_v1',
  models: {
    music_v1: { name: 'Eleven Music v1', pricing: PRICE, capabilities: MUSIC_CAPS },
    music_v2: { name: 'Eleven Music v2', pricing: PRICE, capabilities: MUSIC_CAPS },
    music_v2_5: { name: 'Eleven Music v2.5', pricing: PRICE, capabilities: MUSIC_CAPS },
  },
  rights(plan) {
    const p = PLANS[String(plan ?? '').toLowerCase()];
    return {
      license: {
        code: 'Eleven Music Terms',
        weights: null,
        commercial: p?.commercial ?? 'conditional',
        attribution: p?.attribution ?? null,
        conditions: p ? (p.conditions ?? null) : 'Depends on your ElevenLabs plan: set "plan" in engines.json (starter, creator, pro…). Starter doesn’t allow distribution to streaming services.',
        url: TERMS,
      },
      output_rights: { commercial: p?.commercial === 'yes' ? 'yes' : 'conditional', terms_url: TERMS, ...(plan ? { plan: String(plan) } : {}) },
    };
  },
  data_policy: { uploads_audio: false, retention: 'logged unless zero retention (enterprise)', training_on_inputs: 'unknown', terms_url: TERMS, verified: VERIFIED },

  parseError(status, body) {
    const d = body?.detail;
    if (d?.status === 'bad_prompt' || d?.status === 'bad_composition_plan') {
      const suggestion = d.data?.prompt_suggestion ?? (d.data?.composition_plan_suggestion ? 'ElevenLabs suggested another composition plan' : undefined);
      return new GatewayError('moderation', 'ElevenLabs', 'ElevenLabs refused the prompt: no artist names, song or album titles, labels or lyrics of existing songs', { status, suggestion });
    }
    if (status === 401) return new GatewayError('auth', 'ElevenLabs', 'ElevenLabs refused the API key', { status });
    if (status === 403) return new GatewayError('auth', 'ElevenLabs', 'ElevenLabs refused the request: the Music API needs a paid plan, and the key may be limited (scope, quota, IP allowlist)', { status });
    if (status === 429) return new GatewayError('rate', 'ElevenLabs', 'ElevenLabs: too many generations at once for your plan', { status, retryable: true });
    if (status === 422 && Array.isArray(d)) return new GatewayError('bad_request', 'ElevenLabs', `ElevenLabs: ${d.map((x) => `${(x.loc ?? []).join('.')}: ${x.msg}`).join('; ')}`, { status });
    return null;
  },

  /** The request body: a composition plan from the sections, or a prompt and a length. */
  body(model, scp, request, seed) {
    const s = scopeTimes(scp);
    const style = styleText(scp, request);
    const globals = [style, scp.song?.bpm ? `${Math.round(scp.song.bpm)} BPM` : '', keyWords(scp.song?.key)].filter(Boolean);
    const sections = sectionsInScope(scp).filter((x) => x.ms >= 3000);
    const clamp = (ms) => Math.max(3000, Math.min(120000, ms));
    const instrumental = !sections.some((x) => x.lines.length) && !(scp.lyrics?.lines ?? []).length;
    if (sections.length && sections.every((x) => x.ms <= 120000)) {
      if (model === 'music_v1') {
        return {
          model_id: model,
          composition_plan: {
            positive_global_styles: globals.length ? globals : ['instrumental'],
            negative_global_styles: instrumental ? ['vocals'] : [],
            sections: sections.map((x) => ({ section_name: x.name, positive_local_styles: [x.kind, x.energy !== undefined ? (x.energy > 0.66 ? 'high energy' : x.energy < 0.33 ? 'low energy' : 'medium energy') : ''].filter(Boolean), negative_local_styles: [], duration_ms: clamp(x.ms), lines: x.lines.slice(0, 30).map((l) => l.slice(0, 200)) })),
          },
          ...(seed ? { seed } : {}),
        };
      }
      return {
        model_id: model,
        composition_plan: { chunks: sections.slice(0, 30).map((x) => ({ text: `[${x.name}]${x.lines.length ? `\n${x.lines.join('\n')}` : ''}`, duration_ms: clamp(x.ms), positive_styles: globals.slice(0, 50), negative_styles: instrumental ? ['vocals'] : [] })) },
        ...(seed ? { seed } : {}),
      };
    }
    return { model_id: model, prompt: promptText(scp, request) || 'instrumental music', music_length_ms: Math.max(3000, Math.min(600000, Math.round(s.seconds * 1000))), force_instrumental: instrumental };
  },

  async run({ capability, model, scp, request, seed, http, config }) {
    const risk = promptRisks(styleText(scp, request));
    if (risk) throw new GatewayError('moderation', 'ElevenLabs', `Not sent: ${risk}`);
    const body = this.body(model, scp, request, seed);
    const format = config.output_format ?? 'mp3_48000_192';
    const { bytes, headers } = await http.bytes(`/v1/music?output_format=${encodeURIComponent(format)}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, timeoutMs: 10 * 60_000 });
    const s = scopeTimes(scp);
    return {
      files: [{ bytes, role: capability === 'music.song' ? 'full' : 'layer' }],
      provenance: { prompt: body.prompt ?? JSON.stringify(body.composition_plan).slice(0, 2000), request_id: headers.get('song-id') ?? headers.get('request-id') ?? headers.get('x-request-id') ?? undefined },
      cost_usd: +((s.seconds / 60) * PRICE.usd).toFixed(4),
    };
  },
};
