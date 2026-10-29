import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runConformance } from './conformance.mjs';
import { createFakeCloud } from './fixtures/fake-cloud.mjs';
import { audioParts } from './cloud/drivers/lyria.mjs';
import { promptRisks, sniffAudio } from './cloud/runtime.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const ENGINE = path.join(here, 'cloud-engine.mjs');
const KEYS = { STABILITY_API_KEY: 'sk-stab', ELEVENLABS_API_KEY: 'el-key', MUREKA_API_KEY: 'mu-key', GEMINI_API_KEY: 'g-key' };
let fake: ReturnType<typeof createFakeCloud>;
let base = '';

const SONG = {
  scp: '1.0',
  song: { title: 'Fuori', bpm: 120, key: 'Am', meter: '4/4', length_bars: 8 },
  scope: { from_bar: 1, to_bar: 9 },
  sections: [
    { id: 'v', kind: 'verse', from_bar: 1, bars: 4, energy: 0.3 },
    { id: 'c', kind: 'chorus', from_bar: 5, bars: 4, energy: 0.8 },
  ],
  lyrics: { language: 'en', lines: [{ text: 'walking out tonight', section_id: 'v' }, { text: 'all the lights are on', section_id: 'c' }] },
  intent: { text: 'warm indie pop' },
};

async function engine(provider: string, extra: string[] = [], env: Record<string, string> = KEYS) {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [ENGINE, '--provider', provider, '--base', base, ...extra], env: { ...process.env, ...env } as Record<string, string>, stderr: 'ignore' }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
    return r;
  };
  const manifest = JSON.parse(((await c.readResource({ uri: 'omep://manifest' })).contents[0] as { text: string }).text);
  return { call, manifest, close: () => c.close() };
}
const last = (p: string) => [...fake.log].reverse().find((e) => e.path === p) as { body?: Record<string, unknown>; form?: Record<string, string>; query: Record<string, string>; headers: Record<string, string> } | undefined;

beforeAll(async () => {
  fake = createFakeCloud();
  base = await fake.listen();
});
afterAll(() => fake.close());

describe('the music generation gateway (omep-cloud)', () => {
  const LOCAL = () => ({ provider: 'local', name: 'My MusicGen', base_url: base, license: { code: 'MIT', weights: 'MIT', commercial: 'yes', attribution: null, conditions: null }, capabilities: { 'music.add_layer': { request: { path: '/local/generate', body: { prompt: '{text}, {bpm} bpm, {key}', duration: '{seconds}', seed: '{seed}' } } } } });
  it.each([
    ['stability', []],
    ['stability', ['--model', 'stable-audio-3']],
    ['elevenlabs', ['--plan', 'creator']],
    ['mureka', []],
    ['lyria', []],
    ['local', 'config'],
  ] as [string, string[] | 'config'][])('%s %s passes conformance against its documented API', async (provider, extra) => {
    const args = extra === 'config' ? ['--config', JSON.stringify(LOCAL())] : extra;
    const r = await runConformance({ command: process.execPath, args: [ENGINE, '--provider', provider, '--base', base, ...args], env: KEYS });
    expect(r.checks.filter((c) => c.required && !c.ok)).toEqual([]);
    expect(r.cases.length).toBeGreaterThan(0);
  }, 60000);

  it('ElevenLabs: the song’s sections become a composition plan, each as long as its bars', async () => {
    const e = await engine('elevenlabs', ['--plan', 'starter']);
    const r = await e.call('music.song', { context: SONG, seed: 7 });
    expect(r.isError).toBeFalsy();
    const sent = last('/v1/music')!;
    expect(sent.headers['xi-api-key']).toBe('el-key');
    expect(sent.query.output_format).toBe('mp3_48000_192');
    const plan = sent.body!.composition_plan as { positive_global_styles: string[]; sections: { section_name: string; duration_ms: number; lines: string[] }[] };
    expect(plan.positive_global_styles).toEqual(['warm indie pop', '120 BPM', 'A minor']);
    expect(plan.sections.map((s) => [s.section_name, s.duration_ms, s.lines])).toEqual([['Verse', 8000, ['walking out tonight']], ['Chorus', 8000, ['all the lights are on']]]);
    // The plan decides the rights, and they go with the contribution into the ledger.
    expect(e.manifest.license.conditions).toMatch(/streaming services is NOT allowed/);
    expect(e.manifest.runtime.output_rights).toMatchObject({ commercial: 'conditional', plan: 'starter' });
    expect((r.structuredContent!.provenance as { request_id: string }).request_id).toMatch(/^song_/);
    // Names of artists are stopped before anything is sent; ElevenLabs' own refusal comes with its suggestion.
    const before = fake.log.length;
    const named = await e.call('music.song', { context: { ...SONG, intent: { text: 'in the style of The Beatles' } } });
    expect(named.isError).toBe(true);
    expect(named.content[0].text).toMatch(/Not sent: .*Beatles.*describe the sound/);
    expect(fake.log.length).toBe(before);
    const refused = await e.call('music.song', { context: { ...SONG, intent: { text: 'beatles' } } });
    expect(refused.content[0].text).toMatch(/refused the prompt.*try: “upbeat 1960s british rock/);
    await e.close();
  }, 60000);

  it('Stable Audio: a cover is audio-to-audio with Stability’s strength (the inverse of OpenBand’s), English only, credits in words', async () => {
    const e = await engine('stability');
    const { encodeWav } = await import('./lib/audio.mjs');
    const mix = `data:audio/wav;base64,${encodeWav([new Float32Array(22050 * 8).map((_, i) => Math.sin(i / 20) * 0.3)], 22050).toString('base64')}`;
    const r = await e.call('music.restyle', { context: { ...SONG, context_audio: { mix_uri: mix, from_bar: 1, to_bar: 9 } }, request: { strength: 0.7 } });
    expect(r.isError).toBeFalsy();
    const sent = last('/v2beta/audio/stable-audio-2/audio-to-audio')!;
    expect(sent.headers.authorization).toBe('Bearer sk-stab');
    expect(sent.form).toMatchObject({ strength: '0.30', model: 'stable-audio-2.5', output_format: 'wav' });
    expect(sent.form!.audio).toMatch(/^<file \d+>$/);
    const it = await e.call('music.song', { context: { ...SONG, intent: { text: 'pianoforte malinconico, città' } } });
    expect(it.content[0].text).toMatch(/English prompts only/);
    const broke = await e.call('music.song', { context: { ...SONG, intent: { text: 'nocredit' } } });
    expect(broke.content[0].text).toMatch(/out of credits/);
    await e.close();
  }, 60000);

  it('Mureka: one song per request (each is charged), polled to the end, with the words’ timings', async () => {
    const e = await engine('mureka', ['--model', 'mureka-9.5']);
    const r = await e.call('music.song', { context: SONG });
    expect(r.isError).toBeFalsy();
    const sent = last('/v1/song/generate')!;
    expect(sent.body).toMatchObject({ n: 1, model: 'mureka-9.5', lyrics: '[Verse]\nwalking out tonight\n\n[Chorus]\nall the lights are on' });
    expect(fake.log.filter((x) => x.path.startsWith('/v1/song/query/')).length).toBeGreaterThanOrEqual(3);
    const words = (r.structuredContent!.alignment as { syllables: { text: string }[] }).syllables;
    expect(words.map((w) => w.text).slice(0, 3)).toEqual(['walking', 'out', 'tonight']);
    // No lyrics: the instrumental endpoint.
    const inst = await e.call('music.add_layer', { context: { ...SONG, lyrics: undefined } });
    expect(inst.isError).toBeFalsy();
    expect(last('/v1/instrumental/generate')!.body).toMatchObject({ n: 1 });
    const broke = await e.call('music.song', { context: { ...SONG, intent: { text: 'nocredit' } } });
    expect(broke.content[0].text).toMatch(/balance is used up/);
    await e.close();
  }, 60000);

  it('a local model server with a queue, declared in engines.json only', async () => {
    const config = { ...LOCAL(), capabilities: { 'music.add_layer': { request: { path: '/local/jobs', body: { prompt: '{text}', duration: '{seconds}' } }, poll: { id: 'job_id', path: '/local/jobs/{id}', done: 'status=done', audio_url: 'result.url', every_s: 0.2 } } } };
    const e = await engine('local', ['--config', JSON.stringify(config)], {});
    expect(e.manifest.runtime.where).toBe('local');
    expect(e.manifest.engine.id).toBe('omep-local-my-musicgen');
    const r = await e.call('music.add_layer', { context: SONG });
    expect(r.isError).toBeFalsy();
    expect(last('/local/jobs')!.body).toEqual({ prompt: 'warm indie pop', duration: 16 });
    await e.close();
  }, 60000);

  it('without a key it says where to add it; and nothing else leaves', async () => {
    const before = fake.log.length;
    const e = await engine('lyria', [], {});
    const r = await e.call('music.song', { context: SONG });
    expect(r.content[0].text).toMatch(/No Google Lyria key: add it in OpenBand \(Ensemble → Music services\)/);
    expect(fake.log.length).toBe(before);
    await e.close();
  }, 30000);

  it('helpers: audio found wherever an answer puts it, formats by their bytes, names in prompts flagged', () => {
    const wav = Buffer.from('RIFF0000WAVEfmt ' + 'x'.repeat(80));
    expect(audioParts({ steps: [{ content: [{ type: 'text', text: 'hi' }, { type: 'audio', mime_type: 'audio/wav', data: wav.toString('base64') }] }] })).toHaveLength(1);
    expect(sniffAudio(new Uint8Array([0x49, 0x44, 0x33, 4]))).toBe('mp3');
    expect(sniffAudio(new TextEncoder().encode('fLaC'))).toBe('flac');
    expect(promptRisks('warm piano like Ludovico Einaudi')).toMatch(/Ludovico Einaudi/);
    expect(promptRisks('warm piano, slow, intimate')).toBeNull();
  });

  it('keys: written for this user only, never handed back, never on a command line', async () => {
    const { EngineHost, readEnginesConfig } = await import('../server/engines.mjs');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-gw-')), 'engines.json');
    fs.writeFileSync(file, JSON.stringify({ engines: { mine: { builtin: 'omep-mock' } } }));
    const host = new EngineHost({ file });
    await host.setService({ provider: 'elevenlabs', key: 'el-secret-123456', plan: 'creator' });
    expect(fs.statSync(file).mode & 0o777).toBe(process.platform === 'win32' ? fs.statSync(file).mode & 0o777 : 0o600);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.engines.mine).toEqual({ builtin: 'omep-mock' });
    expect(raw.engines['cloud-elevenlabs']).toMatchObject({ builtin: 'omep-cloud', provider: 'elevenlabs', plan: 'creator', env: { ELEVENLABS_API_KEY: 'el-secret-123456' } });
    const list = await host.services();
    expect(list).toEqual([{ id: 'cloud-elevenlabs', provider: 'elevenlabs', name: 'ElevenLabs Music', model: 'music_v1', plan: 'creator', has_key: true }]);
    expect(JSON.stringify(list)).not.toMatch(/el-secret/);
    const spec = readEnginesConfig(file)['cloud-elevenlabs'];
    expect(spec.args.join(' ')).not.toMatch(/el-secret/);
    expect(spec.env).toEqual({ ELEVENLABS_API_KEY: 'el-secret-123456' });
    // A new plan keeps the key; a bad key is refused; removing takes it away.
    await host.setService({ provider: 'elevenlabs', plan: 'pro' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).engines['cloud-elevenlabs'].env.ELEVENLABS_API_KEY).toBe('el-secret-123456');
    await expect(host.setService({ provider: 'mureka', key: 'x y' })).rejects.toThrow(/doesn't look like/);
    await expect(host.setService({ provider: 'nope', key: 'abcdefghij' })).rejects.toThrow(/Unknown music service/);
    expect(await host.removeService('cloud-elevenlabs')).toEqual({ removed: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).engines['cloud-elevenlabs']).toBeUndefined();
    await host.close();
  }, 30000);
});
