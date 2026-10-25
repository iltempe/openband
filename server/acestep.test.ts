// omep-ace-step (SPEC v0.6 §10) against a mock of ACE-Step 1.5's REST server (release_task →
// query_result → /v1/audio), as its API documentation describes it: the OMEP capabilities become
// ACE-Step's tasks, the song's audio goes up as src_audio, the answer is trimmed to the scope, and the
// engine over MCP gives valid OMEP contributions.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AceStepApi, keyScale, legoTrack, manifestFor, taskFor, trimWav } from '../omep/lib/acestep.mjs';
import { validate } from '../omep/lib/schemas.mjs';
import { decodeWav, encodeWav } from '../omep/lib/audio.mjs';

/** 8 bars at 120 BPM in A minor (2 s a bar), scope bars 3–4. */
const SCP = { scp: '1.0', song: { bpm: 120, meter: '4/4', key: 'Am', length_bars: 8 }, scope: { from_bar: 3, to_bar: 5 }, lyrics: { language: 'it', lines: [{ text: 'notte a Trastevere' }] } };
const SR = 8000;
/** A WAV whose sample value says where it is: second n has amplitude 0.1·(n+1). */
const marked = (seconds: number) => Buffer.from(encodeWav([Float32Array.from({ length: seconds * SR }, (_, i) => 0.1 * (Math.floor(i / SR) + 1))], SR));

let mock: http.Server;
let base = '';
const tasks = new Map<string, { fields: Record<string, string>; upload: number; polls: number }>();
beforeAll(async () => {
  mock = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const send = (code: number, json: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(json)));
    if (req.headers.authorization !== 'Bearer sekret') return send(401, { detail: 'Invalid API key' });
    if (req.url === '/release_task') {
      let fields: Record<string, string> = {};
      let upload = 0;
      if (/multipart/.test(req.headers['content-type'] ?? '')) {
        const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type']! } }).formData();
        for (const [k, v] of form.entries()) if (typeof v === 'string') fields[k] = v;
        else upload = (v as Blob).size;
      } else fields = JSON.parse(raw.toString());
      const id = `t${tasks.size + 1}`;
      tasks.set(id, { fields, upload, polls: 0 });
      return send(200, { data: { task_id: id, status: 'queued', queue_position: 1 }, code: 200, error: null });
    }
    if (req.url === '/query_result') {
      const { task_id_list } = JSON.parse(raw.toString());
      const t = tasks.get(task_id_list[0])!;
      t.polls++;
      if (t.fields.prompt === 'crash') return send(200, { data: [{ task_id: task_id_list[0], status: 2, error: 'CUDA out of memory' }], code: 200 });
      const done = t.polls > 1;
      return send(200, { data: [{ task_id: task_id_list[0], status: done ? 1 : 0, result: done ? JSON.stringify([{ file: `/v1/audio?path=${encodeURIComponent(`/out/${task_id_list[0]}.wav`)}`, status: 1, seed_value: '42' }]) : '' }], code: 200 });
    }
    if (req.url!.startsWith('/v1/audio')) {
      const t = tasks.get(/out\/(t\d+)\.wav/.exec(decodeURIComponent(req.url!))![1])!;
      // text2music: the duration asked; repaint/lego/cover: as long as the audio sent (10 s here).
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(marked(t.fields.task_type === 'text2music' ? Number(t.fields.audio_duration) : 10));
    }
    send(404, { detail: 'not found' });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
});
afterAll(() => mock.close());

describe('ACE-Step 1.5 as an OMEP engine', () => {
  it('manifests are valid; adding a layer only with a base model', () => {
    const turbo = manifestFor('acestep-v15-turbo');
    expect(validate('manifest', turbo)).toEqual([]);
    expect(Object.keys(turbo.capabilities)).toEqual(['music.song', 'music.repaint', 'music.restyle']);
    expect(Object.keys(manifestFor('acestep-v15-base').capabilities)).toContain('music.add_layer');
    expect(turbo.license).toMatchObject({ code: 'MIT', weights: 'MIT', commercial: 'yes' });
  });

  it('maps OMEP requests onto ACE-Step tasks', () => {
    expect(keyScale('Am')).toBe('A minor');
    expect(keyScale('F#')).toBe('F# major');
    expect([legoTrack({ text: 'funky guitar' }), legoTrack({ role: 'bass' }), legoTrack({ instrument: 'rhodes' }), legoTrack({ text: 'cori' })]).toEqual(['guitar', 'bass', 'keyboard', 'backing_vocals']);
    const song = taskFor('music.song', SCP, { text: 'dream pop' }, 7);
    expect(song).toMatchObject({ task_type: 'text2music', prompt: 'dream pop', bpm: 120, key_scale: 'A minor', time_signature: '4', seed: 7, use_random_seed: false, audio_format: 'wav', lyrics: 'notte a Trastevere', vocal_language: 'it', audio_duration: 10 });
    // Repaint: the scope (bars 3–4 = 4…8 s) inside context audio that starts at bar 1.
    expect(taskFor('music.repaint', SCP, {}, 1, { start: 0 })).toMatchObject({ task_type: 'repaint', repainting_start: 4, repainting_end: 8 });
    expect(taskFor('music.add_layer', SCP, { text: 'strings' }, 1, { start: 4 })).toMatchObject({ task_type: 'lego', instruction: 'Generate the strings track based on the audio context:' });
    expect(taskFor('music.restyle', SCP, { text: 'bossa nova' })).toMatchObject({ task_type: 'cover', audio_cover_strength: 0.5 });
  });

  it('trims an answer to the scope', () => {
    const out = decodeWav(trimWav(marked(10), 4, 4));
    expect(out.channels[0].length).toBe(4 * SR);
    expect(out.channels[0][0]).toBeCloseTo(0.5, 3);
    expect(out.channels[0].at(-1)).toBeCloseTo(0.8, 3);
  });

  it('submits, follows and downloads; says plainly when it failed', async () => {
    const api = new AceStepApi({ base, key: 'sekret' });
    const r = await api.run(taskFor('music.song', SCP, { text: 'x' }, 1), null, { pollMs: 5 });
    expect(decodeWav(Buffer.from(r.bytes)).channels[0].length).toBe(10 * SR);
    expect(r.seed).toBe(42);
    await expect(api.run({ ...taskFor('music.song', SCP), prompt: 'crash' }, null, { pollMs: 5 })).rejects.toThrow(/CUDA out of memory/);
    await expect(new AceStepApi({ base, key: 'wrong' }).run(taskFor('music.song', SCP), null)).rejects.toThrow(/401.*Invalid API key/);
  });

  const connect = async (env: Record<string, string>, args: string[] = []) => {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'omep', 'ace-step-engine.mjs'), ...args], env: { ...process.env, ACESTEP_POLL_MS: '5', ...env } as Record<string, string>, stderr: 'ignore' }));
    return c;
  };

  it('over MCP: a song, and a repaint with the song audio uploaded and the answer trimmed to the scope', async () => {
    const c = await connect({ ACESTEP_API_URL: base, ACESTEP_API_KEY: 'sekret' });
    try {
      const song = (await c.callTool({ name: 'music.song', arguments: { context: SCP, request: { text: 'dream pop' }, seed: 3 } }, CallToolResultSchema, { timeout: 30000 })).structuredContent as Record<string, any>;
      expect(validate('contribution', song)).toEqual([]);
      expect(song).toMatchObject({ kind: 'audio', provenance: { engine: 'ace-step', capability: 'music.song' }, license: { code: 'MIT' } });
      expect(song.files[0].role).toBe('full');
      const ctx = `data:audio/wav;base64,${marked(10).toString('base64')}`;
      const before = tasks.size;
      const rp = (await c.callTool({ name: 'music.repaint', arguments: { context: { ...SCP, context_audio: { mix_uri: ctx, from_bar: 1, to_bar: 6 } }, request: { text: 'calmer' } } }, CallToolResultSchema, { timeout: 30000 })).structuredContent as Record<string, any>;
      expect(validate('contribution', rp)).toEqual([]);
      const sent = [...tasks.values()][before];
      expect(sent.fields).toMatchObject({ task_type: 'repaint', repainting_start: '4', repainting_end: '8' });
      expect(sent.upload).toBe(marked(10).length);
      const wav = decodeWav(fs.readFileSync(fileURLToPath(rp.files[0].uri)));
      // Seconds 4…8 of the answer: the scope only.
      expect(wav.channels[0].length).toBe(4 * SR);
      expect(wav.channels[0][0]).toBeCloseTo(0.5, 3);
      expect(rp.files[0].role).toBe('layer');
      const tools = (await c.listTools()).tools.map((t) => t.name);
      expect(tools).not.toContain('music.add_layer');
    } finally {
      await c.close();
    }
  }, 60000);

  it('says how to start ACE-Step when it is not running', async () => {
    const c = await connect({ ACESTEP_API_URL: 'http://127.0.0.1:9' }, ['--model', 'acestep-v15-base']);
    try {
      expect((await c.listTools()).tools.map((t) => t.name)).toContain('music.add_layer');
      const r = await c.callTool({ name: 'music.song', arguments: { context: SCP } }, CallToolResultSchema, { timeout: 30000 });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/uv run acestep-api/);
    } finally {
      await c.close();
    }
  }, 60000);
});
