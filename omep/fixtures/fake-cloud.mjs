// Stand-ins for the music services the gateway speaks to (omep/cloud/drivers/), built from their documented
// requests and answers (2026-10-30). One server, the providers by path. Instead of a model, each makes audio
// that shows what it was asked: as long as the request says, a chord on every beat at the "<n> bpm" and in
// the "<X> major|minor" of its words — so conformance measures real adherence. Every request is logged
// (`log`) for the tests. Triggers: a prompt with "Beatles" is refused like ElevenLabs/Stability refuse
// names; "nocredit" answers 402/quota; Mureka's task runs through queued → running → succeeded.
import http from 'node:http';
import { decodeWav, encodeWav } from '../lib/audio.mjs';

const NAMES = { c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5, 'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11 };

/** The audio a request "asks for". */
export function render(text = '', seconds = 10) {
  const bpm = Number(/(\d+(?:\.\d+)?)\s*bpm/i.exec(text)?.[1] ?? 120);
  const k = /\b([a-g][#b]?)\s+(major|minor)\b/i.exec(text);
  const root = k ? NAMES[k[1].toLowerCase()] : 0;
  const third = k && /minor/i.test(k[2]) ? 3 : 4;
  const sr = 22050;
  const x = new Float32Array(Math.max(1, Math.round(seconds * sr)));
  const beat = Math.round((60 / bpm) * sr);
  for (let i = 0; i < x.length; i++) {
    const t = (i % beat) / sr;
    for (const st of [0, third, 7]) x[i] += 0.2 * Math.exp(-t * 6) * Math.sin((2 * Math.PI * 440 * 2 ** ((48 + root + st - 69) / 12) * i) / sr);
  }
  return encodeWav([x], sr);
}

const darker = (bytes) => {
  const { sampleRate, channels } = decodeWav(bytes);
  return encodeWav(channels.map((c) => { const y = new Float32Array(c.length); let lp = 0; for (let i = 0; i < c.length; i++) y[i] = lp += 0.1 * (c[i] - lp); return y; }), sampleRate);
};

export function createFakeCloud({ keys = { stability: 'sk-stab', elevenlabs: 'el-key', mureka: 'mu-key', lyria: 'g-key', local: '' } } = {}) {
  const log = [];
  const tasks = new Map();
  const files = new Map();
  let n = 0;
  let base = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const send = (code, body, headers = {}) => {
      const isBytes = Buffer.isBuffer(body);
      res.writeHead(code, { 'content-type': isBytes ? 'audio/wav' : 'application/json', ...headers });
      res.end(isBytes ? body : JSON.stringify(body));
    };
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
    log.push(entry);
    const p = url.pathname;

    // ---- Stable Audio
    if (p.startsWith('/v2beta/audio/')) {
      if (req.headers.authorization !== `Bearer ${keys.stability}`) return send(401, { id: 'e1', name: 'unauthorized', errors: ['The API key is missing or invalid.'] });
      if (p.startsWith('/v2beta/audio/results/')) {
        const t = tasks.get(p.split('/').pop());
        if (!t) return send(404, { id: 'e', name: 'generation_not_found', errors: ['not found'] });
        if (t.polls++ < 1) return send(202, { id: t.id, status: 'in-progress' });
        return send(200, t.audio);
      }
      if (!/multipart\/form-data/.test(req.headers['content-type'] ?? '')) return send(400, { id: 'e', name: 'bad_request', errors: ['must be multipart/form-data'] });
      const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
      const f = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.size}>`]));
      entry.form = f;
      const prompt = String(form.get('prompt') ?? '');
      if (/beatles/i.test(prompt)) return send(403, { id: 'e2', name: 'content_moderation', errors: ['Your request was flagged by our content moderation system.'] });
      if (/[àèéìòù]/i.test(prompt)) return send(422, { id: 'e3', name: 'invalid_language', errors: ['English is the only supported language for this service.'] });
      if (/nocredit/.test(prompt)) return send(402, { id: 'e4', name: 'payment_required', errors: ['Your account doesn\'t have enough credits.'] });
      const audio = form.get('audio');
      const out = p.endsWith('audio-to-audio') && audio ? darker(Buffer.from(await audio.arrayBuffer())) : render(prompt, Number(form.get('duration') ?? 10));
      if (p === '/v2beta/audio/stable-audio/text-to-audio') {
        const id = 'g'.repeat(60) + String(++n).padStart(4, '0');
        tasks.set(id, { id, polls: 0, audio: out });
        return send(202, { id });
      }
      return send(200, out, { seed: String(form.get('seed') ?? 42), 'x-request-id': `stab-${++n}`, 'finish-reason': 'SUCCESS' });
    }

    // ---- ElevenLabs
    if (p === '/v1/music') {
      if (req.headers['xi-api-key'] !== keys.elevenlabs) return send(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      const body = JSON.parse(String(raw));
      entry.body = body;
      const words = JSON.stringify(body);
      if (/beatles/i.test(words)) return send(400, { detail: { status: 'bad_prompt', message: 'prompt names an artist', data: { prompt_suggestion: 'upbeat 1960s british rock with jangly guitars, 120 bpm' } } });
      const plan = body.composition_plan;
      const ms = plan?.sections ? plan.sections.reduce((a, s) => a + s.duration_ms, 0) : plan?.chunks ? plan.chunks.reduce((a, s) => a + s.duration_ms, 0) : body.music_length_ms ?? 30000;
      const styles = plan?.positive_global_styles?.join(', ') ?? plan?.chunks?.[0]?.positive_styles?.join(', ') ?? body.prompt ?? '';
      return send(200, render(styles, ms / 1000), { 'song-id': `song_${++n}` });
    }

    // ---- Mureka
    if (p.startsWith('/v1/song/') || p.startsWith('/v1/instrumental/')) {
      if (req.headers.authorization !== `Bearer ${keys.mureka}`) return send(401, { error: { message: 'Invalid Authentication' }, trace_id: 't401' });
      const kind = p.split('/')[2];
      if (p.endsWith('/generate') && req.method === 'POST') {
        const body = JSON.parse(String(raw));
        entry.body = body;
        if (kind === 'song' && !body.lyrics) return send(400, { error: { message: 'lyrics is required' }, trace_id: 't400' });
        if (/nocredit/.test(body.prompt ?? '')) return send(429, { error: { message: 'You exceeded your current quota, please check your billing details' }, trace_id: 't429' });
        const id = String(1436000 + ++n);
        tasks.set(id, { id, kind, polls: 0, body });
        return send(200, { id, created_at: 1793316152, model: body.model === 'auto' ? 'mureka-9.5' : body.model, status: 'preparing', trace_id: `trace-${id}` });
      }
      if (p.includes('/query/')) {
        const t = tasks.get(p.split('/').pop());
        if (!t) return send(400, { error: { message: 'task not found' } });
        const states = ['queued', 'running', 'succeeded'];
        const status = states[Math.min(t.polls++, 2)];
        if (status !== 'succeeded') return send(200, { id: t.id, status, model: t.body.model });
        const seconds = t.body.duration ?? 12;
        const file = `cdn/${t.id}.wav`;
        files.set(`/${file}`, render(t.body.prompt ?? '', seconds));
        const lines = String(t.body.lyrics ?? '').split('\n').filter((l) => l && !l.startsWith('['));
        return send(200, {
          id: t.id, status, model: t.body.model, finished_at: 1793316200,
          choices: [{ index: 0, id: `song-${t.id}`, url: `${base}/${file.replace('.wav', '.mp3')}`, wav_url: `${base}/${file}`, duration: seconds * 1000,
            lyrics_sections: lines.length ? [{ section_type: 'verse', start: 0, end: seconds * 1000, lines: lines.map((text, i) => ({ start: i * 2000, end: i * 2000 + 1800, text, words: text.split(' ').map((w, j) => ({ start: i * 2000 + j * 300, end: i * 2000 + j * 300 + 250, text: w })) })) }] : [] }],
        });
      }
    }
    if (files.has(p)) return send(200, files.get(p));

    // ---- Lyria (Gemini API)
    if (p === '/v1beta/interactions') {
      if (req.headers['x-goog-api-key'] !== keys.lyria) return send(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
      const body = JSON.parse(String(raw));
      entry.body = body;
      const seconds = body.model === 'lyria-3-clip-preview' ? 30 : Number(/about (\d+) seconds/.exec(body.input)?.[1] ?? 60);
      return send(200, { id: `int_${++n}`, model: body.model, status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Here is your track.' }, { type: 'audio', mime_type: 'audio/wav', data: render(body.input, seconds).toString('base64') }] }] });
    }

    // ---- a local model server, as a user might have one
    if (p === '/local/generate') {
      const body = JSON.parse(String(raw));
      entry.body = body;
      return send(200, render(`${body.prompt}`, Number(body.duration ?? 10)));
    }
    if (p === '/local/jobs' && req.method === 'POST') {
      const body = JSON.parse(String(raw));
      entry.body = body;
      const id = `job${++n}`;
      tasks.set(id, { id, polls: 0, body });
      return send(200, { job_id: id });
    }
    if (p.startsWith('/local/jobs/')) {
      const t = tasks.get(p.split('/').pop());
      if (t.polls++ < 1) return send(200, { status: 'running' });
      files.set(`/local/out/${t.id}.wav`, render(`${t.body.prompt}`, Number(t.body.duration ?? 10)));
      return send(200, { status: 'done', result: { url: `/local/out/${t.id}.wav` } });
    }
    send(404, { error: { message: `no route ${req.method} ${p}` } });
  });
  return {
    log,
    listen: () => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok((base = `http://127.0.0.1:${server.address().port}`)))),
    close: () => new Promise((ok) => server.close(ok)),
  };
}
