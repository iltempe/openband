import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runConformance } from './conformance.mjs';
import { fillWorkflow, readMapping } from './lib/comfyui.mjs';
import { createFakeComfy } from './fixtures/fake-comfyui.mjs';
import { decodeWav } from './lib/audio.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const example = path.join(here, 'comfyui', 'omep.example.json');
let fake: ReturnType<typeof createFakeComfy>;
let url = '';
const engine = (mapping = example) => ({ command: process.execPath, args: [path.join(here, 'comfyui-engine.mjs'), '--mapping', mapping, '--url', url], env: { OMEP_COMFYUI_POLL_MS: '50' } });

beforeAll(async () => {
  fake = createFakeComfy();
  url = `http://127.0.0.1:${await fake.listen()}`;
});
afterAll(() => fake.close());

describe('omep-comfyui', () => {
  it('the example mapping over ComfyUI passes conformance, with the song in the workflow', async () => {
    const r = await runConformance(engine());
    expect(r.checks.filter((c) => c.required && !c.ok)).toEqual([]);
    const song = r.cases.find((c) => c.capability === 'music.song')!;
    // The fake makes what the workflow asked for: tempo, key and length come from the bindings.
    expect(song.adherence).toBeGreaterThan(0.8);
    expect(r.cases.find((c) => c.capability === 'music.restyle')).toBeTruthy();
    // The song's audio went to ComfyUI's input folder for the cover; nothing else was uploaded.
    expect([...fake.inputs.keys()].every((k) => /^openband-.*\.wav$/.test(k))).toBe(true);
    const sent = [...fake.prompts.values()].map((p) => p.prompt);
    const tags = sent.find((w) => w['4'])!['2'].inputs.tags;
    expect(tags).toMatch(/\d+ bpm/);
    expect(sent.find((w) => w['8'])!['8'].inputs.audio).toMatch(/^openband-/);
  }, 60000);

  it('fills the workflow: templates, values, constants, the denoise of a cover', () => {
    const m = readMapping(example);
    const scp = { scp: '1.0', song: { bpm: 92, key: 'Dm', meter: '4/4', length_bars: 8 }, scope: { from_bar: 1, to_bar: 9 }, intent: { text: 'warm folk' }, lyrics: { language: 'it', lines: [{ text: 'una riga' }] } };
    const w = fillWorkflow(m.capabilities['music.song'], scp, {}, 42, null);
    expect(w['2'].inputs.tags).toBe('warm folk, 92 bpm, D minor');
    expect(w['2'].inputs.lyrics).toBe('una riga');
    expect(w['4'].inputs.seconds).toBeCloseTo(8 * 4 * (60 / 92), 1);
    expect(w['5'].inputs.seed).toBe(42);
    expect(w['5'].inputs.steps).toBe(50); // untouched
    const c = fillWorkflow(m.capabilities['music.restyle'], scp, { strength: 0.7 }, 1, 'openband-x.wav');
    expect(c['5'].inputs.denoise).toBeCloseTo(0.3);
    expect(c['8'].inputs.audio).toBe('openband-x.wav');
    expect(() => fillWorkflow(m.capabilities['music.restyle'], scp, {}, 1, null)).toThrow(/song's audio/);
    const instrumental = fillWorkflow(m.capabilities['music.song'], { ...scp, intent: undefined, lyrics: undefined }, {}, 1, null);
    expect(instrumental['2'].inputs.tags).toBe('92 bpm, D minor');
    expect(instrumental['2'].inputs.lyrics).toBe('[Instrumental]');
  });

  it('a mapping that does not fit its workflow says what is wrong, line by line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-comfy-'));
    fs.copyFileSync(path.join(here, 'comfyui', 'ace-step.api.json'), path.join(dir, 'wf.json'));
    fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ capabilities: { 'music.song': { workflow: 'wf.json', inputs: { '99.tags': 'intent.text', '2.lyrics': 'lyrics.words' }, output: '42' }, 'symbolic.drums': { workflow: 'wf.json' }, 'music.extend': { workflow: 'none.json' } } }));
    expect(() => readMapping(path.join(dir, 'm.json'))).toThrow(/node 99 is not in wf\.json[\s\S]*unknown value "lyrics\.words"[\s\S]*output node 42[\s\S]*symbolic\.drums: omep-comfyui plays capabilities that make audio[\s\S]*none\.json: not found/);
  });

  it('missing custom nodes and run-time failures come back in words', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-comfy-'));
    const wf = JSON.parse(fs.readFileSync(path.join(here, 'comfyui', 'ace-step.api.json'), 'utf8'));
    wf['1'].class_type = 'HeartMuLaLoader';
    fs.writeFileSync(path.join(dir, 'wf.json'), JSON.stringify(wf));
    fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ capabilities: { 'music.song': { workflow: 'wf.json', inputs: { '5.seed': 'seed' } } } }));
    const r = await runConformance(engine(path.join(dir, 'm.json')));
    const answer = r.checks.find((c) => /music\.song: (answers|contribution)/.test(c.id) && !c.ok);
    expect(answer?.detail).toMatch(/HeartMuLaLoader.*not found.*Install the custom nodes/);
    // Seed 666 makes the fake fail while running (like a GPU out of memory).
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 't', version: '1' });
    const e = engine();
    await client.connect(new StdioClientTransport({ command: e.command, args: e.args, env: { ...process.env, ...e.env } as Record<string, string>, stderr: 'ignore' }));
    const out = await client.callTool({ name: 'music.song', arguments: { context: { scp: '1.0', song: { bpm: 100, key: 'C', meter: '4/4', length_bars: 2 } }, seed: 666 } });
    expect(out.isError).toBe(true);
    expect((out.content as { text: string }[])[0].text).toMatch(/KSampler.*CUDA out of memory/);
    await client.close();
  }, 60000);

  it('the fake really makes what the workflow says (sanity of the stand-in)', async () => {
    const res = await fetch(`${url}/prompt`, { method: 'POST', body: JSON.stringify({ prompt: { '2': { class_type: 'TextEncodeAceStepAudio', inputs: { tags: '100 bpm, A minor' } }, '4': { class_type: 'EmptyAceStepLatentAudio', inputs: { seconds: 3 } }, '7': { class_type: 'SaveAudio', inputs: { audio: ['4', 0] } } } }) });
    const { prompt_id } = await res.json();
    await new Promise((ok) => setTimeout(ok, 250));
    const h = (await (await fetch(`${url}/history/${prompt_id}`)).json())[prompt_id];
    const f = h.outputs['7'].audio[0];
    const wav = Buffer.from(await (await fetch(`${url}/view?filename=${f.filename}&subfolder=audio&type=output`)).arrayBuffer());
    const { sampleRate, channels } = decodeWav(wav);
    expect(channels[0].length / sampleRate).toBeCloseTo(3, 1);
  });
});
