// omep-diffsinger (SPEC v0.6 §10): the song context becomes a DiffSinger .ds — phrases, phonemes with
// their durations adding up to the notes, the pitch curve — run by the user's DiffSinger (here a stand-in
// that checks the file as DiffSinger reads it and sings the f0 as a sine), and the answer is the scope.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { noteName, sungNotes, toDs } from '../omep/lib/diffsinger.mjs';
import { validate } from '../omep/lib/schemas.mjs';
import { decodeWav } from '../omep/lib/audio.mjs';

/** "notte‿a Trastevere" on six notes at 120 BPM (0.5 s a beat), a rest before the last two. */
const SCP = {
  scp: '1.0',
  song: { bpm: 120, meter: '4/4', key: 'Am', length_bars: 2 },
  scope: { from_bar: 1, to_bar: 3 },
  melody: { notes: [57, 60, 62, 64, 62, 57].map((pitch, i) => ({ pitch, start: i < 4 ? i : i + 1, duration: 0.9 })) },
  lyrics: {
    language: 'it',
    lines: [{ text: 'notte a Trastevere', syllables: [['not', 'n o t'], ['te‿a', 't e a'], ['Tra', 't r a'], ['ste', 's t e'], ['ve', 'v e'], ['re', 'r e']].map(([text, ph], i) => ({ text, start_beat: i < 4 ? i : i + 1, phonemes: ph.split(' ') })) }],
  },
};

describe('DiffSinger as a singing engine', () => {
  it('writes the .ds DiffSinger reads: words grouped from each vowel, durations that add up to the notes', () => {
    expect([noteName(57), noteName(60), noteName(61)]).toEqual(['A3', 'C4', 'C#4']);
    const notes = sungNotes(SCP);
    expect(notes.map((n) => n.ph.join(' '))).toEqual(['n o t', 't e a', 't r a', 's t e', 'v e', 'r e']);
    const [seg, ...more] = toDs(notes.map((n) => ({ ...n, start: n.start + 0.3, end: n.end + 0.3 })), { phonemes: { E: 'e' } });
    // The beat of rest before "ve" starts a new phrase; the 0.05 s between the others is sung legato.
    expect(more).toHaveLength(1);
    const ph = seg.ph_seq.split(' ');
    const dur = seg.ph_dur.split(' ').map(Number);
    const num = seg.ph_num.split(' ').map(Number);
    const nd = seg.note_dur.split(' ').map(Number);
    expect(num.reduce((a, b) => a + b, 0)).toBe(ph.length);
    let k = 0;
    num.forEach((n, j) => {
      expect(dur.slice(k, k + n).reduce((a, b) => a + b, 0)).toBeCloseTo(nd[j], 3);
      k += n;
    });
    // The opening rest carries the first onset; each note its vowel, coda and the next onset.
    expect(ph.slice(0, 6)).toEqual(['SP', 'n', 'o', 't', 't', 'e']);
    expect(seg.note_seq.split(' ').slice(0, 3)).toEqual(['rest', 'A3', 'C4']);
    expect(seg.offset).toBe(0);
    // f0 every 5 ms over the segment, A3 = 220 Hz on the first note.
    const f0 = seg.f0_seq.split(' ').map(Number);
    expect(f0.length).toBeCloseTo(dur.reduce((a, b) => a + b, 0) / 0.005, -1);
    expect(f0[Math.round(0.45 / 0.005)]).toBeCloseTo(220, 0);
  });

  const fake = path.join(__dirname, 'fixtures', 'fake-diffsinger');
  const connect = async (exp: string, log: string) => {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'omep', 'diffsinger-engine.mjs'), '--repo', fake, '--exp', exp, '--python', process.execPath, '--voicebank', JSON.stringify({ name: 'Test voice', license: 'CC-BY-4.0', commercial: 'yes', url: 'https://example.org/voice' })], env: { ...process.env, FAKE_DS_LOG: log } as Record<string, string>, stderr: 'ignore' }));
    return c;
  };

  it('over MCP: sings the scope with the voicebank, its licence in the contribution', async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-')), 'ds.json');
    const c = await connect('it_test_voice', log);
    try {
      const r = (await c.callTool({ name: 'voice.sing', arguments: { context: SCP, seed: 4 } }, CallToolResultSchema, { timeout: 30000 })).structuredContent as Record<string, any>;
      expect(validate('contribution', r)).toEqual([]);
      expect(r).toMatchObject({ kind: 'audio', provenance: { engine: 'diffsinger', voice: 'Test voice', capability: 'voice.sing' }, license: { code: 'Apache-2.0', weights: 'CC-BY-4.0', commercial: 'yes' } });
      expect(r.files[0].role).toBe('vocal');
      const sent = JSON.parse(fs.readFileSync(log, 'utf8'));
      expect(sent.args).toEqual(expect.arrayContaining(['--exp', 'it_test_voice', '--seed', '4']));
      const w = decodeWav(fs.readFileSync(fileURLToPath(r.files[0].uri)));
      // Exactly the scope (2 bars = 4 s), the pre-roll cut: the first note (A3) sounds at 0.0–0.45 s.
      expect(w.channels[0].length).toBe(4 * w.sampleRate);
      const x = w.channels[0].subarray(Math.round(0.1 * w.sampleRate), Math.round(0.4 * w.sampleRate));
      let crossings = 0;
      for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
      expect(crossings / 0.3).toBeCloseTo(220, -1);
      expect(r.alignment.syllables[0]).toMatchObject({ text: 'not', start_ms: 0 });
    } finally {
      await c.close();
    }
  }, 60000);

  it('a missing voicebank is said plainly; an unconfigured engine says what to set', async () => {
    const c = await connect('nope', path.join(os.tmpdir(), 'ds-none.json'));
    try {
      const r = await c.callTool({ name: 'voice.sing', arguments: { context: SCP } }, CallToolResultSchema, { timeout: 30000 });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/DiffSinger failed.*experiment nope not found/);
    } finally {
      await c.close();
    }
  }, 60000);

  it('on a GPU machine: over HTTP with a token, the voice comes back inline', async () => {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'omep', 'diffsinger-engine.mjs'), '--http', String(port), '--repo', fake, '--exp', 'it_test_voice', '--python', process.execPath], { env: { ...process.env, OMEP_TOKEN: 'gpu-token' }, stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>((r) => p.stderr!.on('data', (d) => String(d).includes('omep-diffsinger on') && r()));
    try {
      expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
      const c = new Client({ name: 't', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: 'Bearer gpu-token' } } }));
      const man = JSON.parse(((await c.readResource({ uri: 'omep://manifest' })).contents[0] as { text: string }).text);
      expect(man.capabilities['voice.sing']).toBeTruthy();
      const r = (await c.callTool({ name: 'voice.sing', arguments: { context: SCP } }, CallToolResultSchema, { timeout: 30000 })).structuredContent as Record<string, any>;
      expect(r.files[0].uri).toMatch(/^data:audio\/wav;base64,/);
      await c.close();
    } finally {
      p.kill();
    }
  }, 60000);
});
