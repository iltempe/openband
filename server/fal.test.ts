// omep-fal (SPEC v0.6 §9-bis) against a mock of fal's queue: submit → status → result, errors,
// cancellation, the price before and after, and the engine over MCP. No real fal key is ever used.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FalQueue, dataUri, inputFor, manifestFor, outputsOf, quote, MAX_DATA_URI_BYTES } from '../omep/lib/fal.mjs';
import { validate } from '../omep/lib/schemas.mjs';
import { encodeWav } from '../omep/lib/audio.mjs';

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'omep', 'fal-catalog.json'), 'utf8'));
const ace = catalog.models.find((m: { id: string }) => m.id === 'ace-step');
const demucs = catalog.models.find((m: { id: string }) => m.id === 'demucs');
const KEY = 'test-key-not-real';

/** A song context: 8 bars at 120 BPM (16 s), A minor, with lyrics. */
const SCP = { scp: '1.0', song: { bpm: 120, meter: '4/4', key: 'Am', length_bars: 8 }, scope: { from_bar: 1, to_bar: 9 }, lyrics: { language: 'en', lines: [{ text: 'hello night' }] } };

/** fal's queue, as documented: Key auth, IN_QUEUE → IN_PROGRESS → COMPLETED, result, PUT cancel. */
let mock: http.Server;
let base = '';
const log: { method: string; url: string; auth?: string; body?: unknown }[] = [];
const jobs = new Map<string, { polls: number; cancelled: boolean; endpoint: string; input: Record<string, unknown> }>();
beforeAll(async () => {
  mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    log.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
    const send = (code: number, json: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.url!.startsWith('/files/')) {
      const seconds = Number(req.url!.split('/')[2]);
      const x = new Float32Array(Math.round(seconds * 8000)).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 8000));
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(Buffer.from(encodeWav([x], 8000)));
    }
    if (req.headers.authorization !== `Key ${KEY}`) return send(401, { detail: 'Invalid key' });
    const m = req.url!.match(/^\/(.+?)\/requests\/([\w-]+)(\/status|\/cancel)?/);
    if (req.method === 'POST' && !m) {
      const endpoint = req.url!.slice(1).split('?')[0];
      const id = `req-${jobs.size + 1}`;
      jobs.set(id, { polls: 0, cancelled: false, endpoint, input: body });
      const app = endpoint.split('/').slice(0, 2).join('/');
      return send(200, { request_id: id, status_url: `${base}/${app}/requests/${id}/status`, response_url: `${base}/${app}/requests/${id}`, cancel_url: `${base}/${app}/requests/${id}/cancel`, queue_position: 1 });
    }
    const job = m && jobs.get(m[2]);
    if (!job) return send(404, { detail: 'NOT_FOUND' });
    if (m![3] === '/cancel') {
      job.cancelled = true;
      return send(202, { status: 'CANCELLATION_REQUESTED' });
    }
    if (m![3] === '/status') {
      job.polls++;
      if (job.endpoint === 'fal-ai/broken' && job.polls > 1) return send(200, { status: 'COMPLETED', request_id: m![2], error: 'The model crashed', error_type: 'internal' });
      if (job.endpoint === 'fal-ai/slow' || job.polls === 1) return send(200, { status: 'IN_QUEUE', request_id: m![2], queue_position: 1 });
      if (job.polls === 2) return send(200, { status: 'IN_PROGRESS', request_id: m![2], logs: [] });
      return send(200, { status: 'COMPLETED', request_id: m![2], metrics: { inference_time: 1.2 } });
    }
    if (job.endpoint === 'fal-ai/demucs') return send(200, Object.fromEntries(['vocals', 'drums', 'bass', 'other'].map((s) => [s, { url: `${base}/files/2/${s}.wav`, content_type: 'audio/wav' }])));
    return send(200, { audio: { url: `${base}/files/${job.input.duration ?? 4}/out.wav`, content_type: 'audio/wav' }, seed: job.input.seed });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
});
afterAll(() => mock.close());

describe('fal models as OMEP engines (§9-bis)', () => {
  it('a catalog entry is a valid OMEP manifest, with its price, data policy and output rights', () => {
    for (const m of catalog.models) {
      const man = manifestFor(m, catalog.verified);
      expect(validate('manifest', man)).toEqual([]);
      expect(man.runtime).toMatchObject({ where: 'cloud', provider: 'fal', pricing: { unit: 'second', verified: catalog.verified } });
    }
  });

  it('fills the model input from the song context; the price before running', () => {
    const input = inputFor(ace, { ...SCP, intent: { text: 'warm lo-fi keys' } } as never, {}, 7);
    expect(input).toEqual({ tags: 'warm lo-fi keys, 120 bpm, A minor', lyrics: 'hello night', duration: 16, seed: 7 });
    expect(quote(ace, SCP as never)).toBeCloseTo(16 * 0.0002, 9);
    expect(quote(demucs, SCP as never, { seconds: 200 })).toBeCloseTo(200 * 0.0007, 9);
    expect(outputsOf(demucs, { vocals: { url: 'v' }, drums: { url: 'd' } })).toEqual([{ role: 'vocal', url: 'v' }, { role: 'drums', url: 'd' }]);
  });

  it("follows fal's queue: submit, status until COMPLETED, result — with the key", async () => {
    const q = new FalQueue({ base, key: KEY });
    const seen: string[] = [];
    const out = await q.run('fal-ai/ace-step', { tags: 'x', duration: 4 }, { pollMs: 5, onStatus: (s: { status: string }) => seen.push(s.status) });
    expect(seen).toEqual(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']);
    expect(out.audio.url).toMatch(/\/files\/4\/out\.wav$/);
    expect(log.filter((l) => l.url.startsWith('/fal-ai')).every((l) => l.auth === `Key ${KEY}`)).toBe(true);
  });

  it('says why: a wrong key, a failed run', async () => {
    await expect(new FalQueue({ base, key: 'wrong' }).run('fal-ai/ace-step', {}, { pollMs: 5 })).rejects.toThrow(/refused the key \(HTTP 401\)/);
    await expect(new FalQueue({ base, key: KEY }).run('fal-ai/broken', {}, { pollMs: 5 })).rejects.toThrow(/The model crashed \(internal\)/);
  });

  it('cancelling stops the request at fal', async () => {
    const ctl = new AbortController();
    const q = new FalQueue({ base, key: KEY });
    const p = q.run('fal-ai/slow', {}, { pollMs: 10, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 40);
    await expect(p).rejects.toThrow(/cancelled/);
    const job = [...jobs.values()].find((j) => j.endpoint === 'fal-ai/slow')!;
    expect(job.cancelled).toBe(true);
  });

  it('context audio goes inline up to a size, and no further', () => {
    expect(dataUri(new Uint8Array([1, 2, 3]))).toBe('data:audio/wav;base64,AQID');
    expect(() => dataUri(new Uint8Array(MAX_DATA_URI_BYTES + 1))).toThrow(/too large/);
  });
});

describe('the omep-fal engine over MCP', () => {
  const connect = async (model: string) => {
    const c = new Client({ name: 'fal-test', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'omep', 'fal-engine.mjs'), '--model', model], env: { ...process.env, FAL_KEY: KEY, FAL_QUEUE_URL: base, FAL_POLL_MS: '10' } as Record<string, string>, stderr: 'ignore' }));
    return c;
  };

  it('music.song: a WAV from fal, as a contribution — the quote and the cost agree within 10 %', async () => {
    const c = await connect('ace-step');
    try {
      const man = JSON.parse((await c.readResource({ uri: 'omep://manifest' })).contents[0].text as string);
      expect(man.engine.id).toBe('fal-ace-step');
      const q = (await c.callTool({ name: 'quote', arguments: { capability: 'music.song', context: SCP } })).structuredContent as { usd: number };
      const r = await c.callTool({ name: 'music.song', arguments: { context: SCP, request: { text: 'dream pop' }, seed: 3 } }, CallToolResultSchema, { timeout: 30000 });
      expect(r.isError).toBeFalsy();
      const contribution = r.structuredContent as { kind: string; files: { uri: string; format: string }[]; cost_usd: number; provenance: { engine: string } };
      expect(validate('contribution', contribution)).toEqual([]);
      expect(contribution).toMatchObject({ kind: 'audio', provenance: { engine: 'fal-ace-step' } });
      expect(fs.existsSync(new URL(contribution.files[0].uri))).toBe(true);
      expect(Math.abs(contribution.cost_usd - q.usd) / q.usd).toBeLessThan(0.1);
      const sent = log.filter((l) => l.method === 'POST' && l.url === '/fal-ai/ace-step').at(-1)!;
      expect(sent.body).toMatchObject({ tags: 'dream pop, 120 bpm, A minor', duration: 16, seed: 3 });
    } finally {
      await c.close();
    }
  }, 30000);

  it('audio.separate: four stems', async () => {
    const c = await connect('demucs');
    try {
      const r = await c.callTool({ name: 'audio.separate', arguments: { context: SCP, request: { audio_url: 'https://example.org/mix.wav', seconds: 2 } } }, CallToolResultSchema, { timeout: 30000 });
      const contribution = r.structuredContent as { kind: string; files: { role: string }[] };
      expect(contribution.kind).toBe('stems');
      expect(contribution.files.map((f) => f.role)).toEqual(['vocal', 'drums', 'bass', 'other']);
      expect(validate('contribution', contribution)).toEqual([]);
    } finally {
      await c.close();
    }
  }, 30000);

  it('without a key it refuses and tells where to set one', async () => {
    const c = new Client({ name: 'fal-test', version: '1' });
    const { FAL_KEY: _k, OPENBAND_FAL_KEY: _o, ...env } = process.env;
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'omep', 'fal-engine.mjs'), '--model', 'ace-step'], env: env as Record<string, string>, stderr: 'ignore' }));
    try {
      const r = await c.callTool({ name: 'music.song', arguments: { context: SCP } }, CallToolResultSchema, { timeout: 30000 });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/No fal key: set FAL_KEY/);
    } finally {
      await c.close();
    }
  }, 30000);
});
