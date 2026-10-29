import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runConformance } from '../omep/conformance.mjs';
import { lyricsFor, tagsFor } from '../omep/lib/heartmula.mjs';

const fake = path.join(__dirname, 'fixtures', 'fake-heartmula');
const engine = (extra: string[] = [], env: Record<string, string> = {}) => ({ command: process.execPath, args: [path.join(__dirname, '..', 'omep', 'heartmula-engine.mjs'), '--repo', fake, '--python', process.execPath, ...extra], env });

describe('HeartMuLa as an OMEP engine', () => {
  it('tags and lyrics the way HeartMuLa reads them', () => {
    const scp = { song: { bpm: 96, key: 'F#m' }, intent: { text: 'Indie Pop, warm; female vocals' }, sections: [{ id: 'v', kind: 'verse' }, { id: 'c', kind: 'chorus' }], lyrics: { language: 'en', lines: [{ text: 'first line', section_id: 'v' }, { text: 'second line', section_id: 'v' }, { text: 'all together', section_id: 'c' }] } };
    expect(tagsFor(scp)).toBe('indie pop,warm,female vocals,96 bpm,f# minor');
    expect(lyricsFor(scp)).toBe('[Verse]\nfirst line\nsecond line\n\n[Chorus]\nall together');
    expect(lyricsFor({ sections: [{ id: 'i', kind: 'intro' }, { id: 'o', kind: 'outro' }] })).toBe('[Intro]\n\n[Outro]');
    expect(lyricsFor({}, { lyrics: '[Verse]\nmine' })).toBe('[Verse]\nmine');
  });

  it('runs heartlib\'s own script in the clone and passes conformance', async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-hm-')), 'log.json');
    const r = await runConformance(engine(['--lazy-load'], { FAKE_HM_LOG: log }));
    expect(r.checks.filter((c) => c.required && !c.ok)).toEqual([]);
    expect(r.cases[0].adherence).toBeGreaterThan(0.8);
    const got = JSON.parse(fs.readFileSync(log, 'utf8'));
    expect(fs.realpathSync(got.cwd)).toBe(fs.realpathSync(fake));
    expect(got.args).toMatchObject({ version: '3B', lazy_load: 'true', model_path: path.join(fake, 'ckpt') });
    expect(got.tags).toMatch(/\d+ bpm/);
    expect(got.args.lyrics).toMatch(/lyrics\.txt$/); // as a file: an inline string that is a path would be read as one
  }, 60000);

  it('says what to set when the clone is missing, and what to do when the GPU runs out of memory', async () => {
    const missing = await runConformance({ ...engine(), args: [path.join(__dirname, '..', 'omep', 'heartmula-engine.mjs'), '--repo', '/nowhere'] });
    expect(missing.checks.find((c) => !c.ok && /music\.song/.test(c.id))?.detail).toMatch(/clone of github\.com\/HeartMuLa\/heartlib.*not found in \/nowhere/);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 't', version: '1' });
    const e = engine();
    await client.connect(new StdioClientTransport({ command: e.command, args: e.args, stderr: 'ignore' }));
    const out = await client.callTool({ name: 'music.song', arguments: { context: { scp: '1.0', song: { bpm: 100, key: 'C', meter: '4/4', length_bars: 4 }, intent: { text: 'oom' } } } });
    expect(out.isError).toBe(true);
    expect((out.content as { text: string }[])[0].text).toMatch(/CUDA out of memory.*lazy_load/);
    await client.close();
  }, 60000);
});
