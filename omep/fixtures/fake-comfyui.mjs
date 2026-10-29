// A stand-in for ComfyUI's HTTP API (server.py) for tests: POST /prompt (validates node types and links),
// GET /history/<id>, GET /view, POST /upload/image. Instead of running a model it makes audio that shows
// what the workflow asked for: as long as EmptyAceStepLatentAudio.seconds, a chord struck on every beat
// at the "<n> bpm" and "<X> major|minor" of the tags; a workflow that loads audio returns that audio
// (darker). A KSampler seed of 666 fails at run time; an unknown class_type is refused like ComfyUI does.
import http from 'node:http';
import { decodeWav, encodeWav } from '../lib/audio.mjs';

const KNOWN = new Set(['CheckpointLoaderSimple', 'TextEncodeAceStepAudio', 'ConditioningZeroOut', 'EmptyAceStepLatentAudio', 'KSampler', 'VAEDecodeAudio', 'VAEEncodeAudio', 'SaveAudio', 'SaveAudioMP3', 'SaveAudioAdvanced', 'LoadAudio', 'PreviewAudio']);
const NAMES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

function render(workflow, inputs) {
  const nodes = Object.values(workflow);
  const load = nodes.find((n) => n.class_type === 'LoadAudio');
  if (load) {
    const bytes = inputs.get(load.inputs.audio);
    if (!bytes) throw new Error(`LoadAudio: ${load.inputs.audio} is not in the input folder`);
    const { sampleRate, channels } = decodeWav(bytes);
    return encodeWav(channels.map((c) => {
      const y = new Float32Array(c.length);
      let lp = 0;
      for (let i = 0; i < c.length; i++) y[i] = lp += 0.1 * (c[i] - lp);
      return y;
    }), sampleRate);
  }
  const seconds = Number(nodes.find((n) => n.class_type === 'EmptyAceStepLatentAudio')?.inputs.seconds ?? 10);
  const tags = String(nodes.find((n) => n.class_type === 'TextEncodeAceStepAudio')?.inputs.tags ?? '');
  const bpm = Number(/(\d+(?:\.\d+)?)\s*bpm/i.exec(tags)?.[1] ?? 120);
  const key = /\b([A-G][#b]?)\s+(major|minor)\b/i.exec(tags);
  const root = key ? NAMES[key[1]] ?? 0 : 0;
  const third = key && /minor/i.test(key[2]) ? 3 : 4;
  const sr = 22050;
  const x = new Float32Array(Math.round(seconds * sr));
  const beat = Math.round((60 / bpm) * sr);
  for (let i = 0; i < x.length; i++) {
    const t = (i % beat) / sr;
    for (const st of [0, third, 7]) x[i] += 0.2 * Math.exp(-t * 6) * Math.sin((2 * Math.PI * 440 * 2 ** ((48 + root + st - 69) / 12) * i) / sr);
  }
  return encodeWav([x], sr);
}

function validate(workflow) {
  const errors = {};
  for (const [id, n] of Object.entries(workflow)) {
    if (!KNOWN.has(n.class_type)) errors[id] = { errors: [{ type: 'missing_node_type', message: `Node '${n.class_type}' not found`, details: '' }], dependent_outputs: [], class_type: n.class_type };
    for (const [k, v] of Object.entries(n.inputs ?? {})) if (Array.isArray(v) && !workflow[v[0]]) errors[id] = { errors: [{ type: 'bad_linked_input', message: `Bad linked input ${k}`, details: '' }], dependent_outputs: [], class_type: n.class_type };
  }
  return errors;
}

export function createFakeComfy({ delayMs = 150 } = {}) {
  const prompts = new Map();
  const inputs = new Map();
  const outputs = new Map();
  const log = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = (code, v) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    log.push(`${req.method} ${url.pathname}`);
    if (req.method === 'POST' && url.pathname === '/prompt') {
      const { prompt } = JSON.parse(String(body));
      if (!prompt) return json(400, { error: { type: 'no_prompt', message: 'No prompt provided', details: '' }, node_errors: {} });
      const errs = validate(prompt);
      if (Object.keys(errs).length) return json(400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' }, node_errors: errs });
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      prompts.set(id, { prompt, at: Date.now() });
      return json(200, { prompt_id: id, number: n, node_errors: {} });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      const p = prompts.get(id);
      if (!p || Date.now() - p.at < delayMs) return json(200, {});
      const ks = Object.entries(p.prompt).find(([, x]) => x.class_type === 'KSampler');
      if (ks && ks[1].inputs.seed === 666) return json(200, { [id]: { prompt: [n, id, p.prompt, {}, []], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { prompt_id: id, node_id: ks[0], node_type: 'KSampler', exception_message: 'CUDA out of memory' }]] } } });
      const [saveId] = Object.entries(p.prompt).find(([, x]) => /^Save/.test(x.class_type)) ?? [];
      const filename = `openband_${id.slice(-4)}_.flac`.replace('.flac', '.wav');
      if (!outputs.has(filename)) {
        try {
          outputs.set(filename, render(p.prompt, inputs));
        } catch (e) {
          return json(200, { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'LoadAudio', exception_message: e.message }]] } } });
        }
      }
      return json(200, { [id]: { prompt: [n, id, p.prompt, {}, [saveId]], outputs: { [saveId]: { audio: [{ filename, subfolder: 'audio', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } } });
    }
    if (req.method === 'GET' && url.pathname === '/view') {
      const f = outputs.get(url.searchParams.get('filename'));
      if (!f) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(f);
    }
    if (req.method === 'POST' && url.pathname === '/upload/image') {
      const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData();
      const file = form.get('image');
      if (!file || typeof file === 'string') return json(400, {});
      inputs.set(file.name, Buffer.from(await file.arrayBuffer()));
      return json(200, { name: file.name, subfolder: '', type: 'input' });
    }
    if (req.method === 'POST' && url.pathname === '/interrupt') return json(200, {});
    res.writeHead(404);
    res.end();
  });
  return {
    log,
    inputs,
    prompts,
    listen: () => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port))),
    close: () => new Promise((ok) => server.close(ok)),
  };
}

// Run by itself (for trying the bridge by hand): node omep/fixtures/fake-comfyui.mjs [port]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const f = createFakeComfy();
  const port = await f.listen();
  console.log(`fake ComfyUI on http://127.0.0.1:${port}`);
}
