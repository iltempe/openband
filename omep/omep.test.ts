import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT, runConformance } from './conformance.mjs';
import { validate } from './lib/schemas.mjs';
import { encodeWav, decodeWav, estimateBpm, estimateKey } from './lib/audio.mjs';
import { keySimilarity } from './lib/music.mjs';

const mock = (...flags: string[]) => ({ command: process.execPath, args: ['omep/mock-engine.mjs', ...flags] });
const failed = (r: { checks: { ok: boolean; required: boolean; id: string }[] }) => r.checks.filter((c) => !c.ok && c.required).map((c) => c.id);

describe('OMEP 1.0', () => {
  it('the mock engine passes conformance with full adherence (protocol, schemas, tasks, cancel, determinism)', async () => {
    const r = await runConformance(mock());
    expect(failed(r)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.adherence).toBeGreaterThan(0.95);
    expect(r.cases.map((c) => c.capability)).toEqual(['symbolic.drums', 'symbolic.accompany', 'music.add_layer', 'music.restyle']);
    expect(r.checks.find((c) => c.id.endsWith('can be cancelled'))?.detail).toMatch(/cancelled|finished/);
  }, 60000);

  it('an engine in the wrong key still conforms, but its adherence drops and the claim is exposed', async () => {
    const r = await runConformance(mock('--wrong-key'));
    expect(r.passed).toBe(true);
    expect(r.adherence).toBeLessThan(0.85);
    const layer = r.cases.find((c) => c.capability === 'music.add_layer')!;
    expect(layer.scores.key).toBe(0);
    expect(layer.notes.join(' ')).toMatch(/claims key Dm, sounds like Ebm/);
  }, 60000);

  it('an engine 10% fast loses the tempo score', async () => {
    const r = await runConformance(mock('--wrong-tempo'));
    const layer = r.cases.find((c) => c.capability === 'music.add_layer')!;
    expect(layer.scores.bpm).toBeLessThan(0.5);
    expect(layer.scores.length).toBeLessThan(0.5);
  }, 60000);

  it('an engine that breaks the Contribution schema fails', async () => {
    const r = await runConformance(mock('--bad-output'));
    expect(r.passed).toBe(false);
    expect(failed(r)).toContain('symbolic.drums: contribution is valid');
  }, 60000);

  it('a command that is not an engine fails cleanly', async () => {
    const r = await runConformance({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 100)'] }, { timeoutMs: 3000 });
    expect(r.passed).toBe(false);
  }, 30000);

  it('schemas: the example context is a valid SCP; bad manifests are caught', () => {
    expect(validate('scp', DEFAULT_CONTEXT)).toEqual([]);
    expect(validate('scp', { ...DEFAULT_CONTEXT, song: { ...DEFAULT_CONTEXT.song, key: 'H' } }).length).toBeGreaterThan(0);
    const base = { omep: '1.0', engine: { id: 'x-engine', name: 'X', version: '1' }, runtime: { where: 'local' }, capabilities: { 'music.song': {} }, outputs: ['audio/wav'], determinism: 'seeded' };
    // CC BY weights need an attribution; conditional licences need their conditions.
    expect(validate('manifest', { ...base, license: { code: 'Apache-2.0', weights: 'CC BY 4.0', commercial: 'yes' } }).join(' ')).toMatch(/attribution/);
    expect(validate('manifest', { ...base, license: { code: 'MIT', weights: 'MIT', commercial: 'conditional' } }).join(' ')).toMatch(/conditions/);
    // Cloud engines must state price, data policy and output rights.
    expect(validate('manifest', { ...base, license: { code: 'MIT', weights: 'MIT', commercial: 'yes' }, runtime: { where: 'cloud' } }).join(' ')).toMatch(/pricing|data_policy|provider/);
    // Unknown capabilities only under the x-vendor namespace.
    expect(validate('manifest', { ...base, license: { code: 'MIT', weights: 'MIT', commercial: 'yes' }, capabilities: { 'music.dance': {} } }).length).toBeGreaterThan(0);
    expect(validate('manifest', { ...base, license: { code: 'MIT', weights: 'MIT', commercial: 'yes' }, capabilities: { 'x-acme.glitch': {} } })).toEqual([]);
  });

  it('measurements: WAV round trip, tempo and key of a synthetic loop', () => {
    const sr = 22050;
    const bpm = 120;
    const x = new Float32Array(sr * 8);
    // A minor arpeggio, one note per beat.
    const pitches = [57, 60, 64, 69];
    for (let b = 0; b < 16; b++) {
      const f = 440 * 2 ** ((pitches[b % 4] - 69) / 12);
      const at = Math.round((b * 60 * sr) / bpm);
      for (let k = 0; k < sr * 0.4 && at + k < x.length; k++) x[at + k] += 0.5 * Math.exp(-k / sr * 6) * Math.sin((2 * Math.PI * f * k) / sr);
    }
    const back = decodeWav(encodeWav([x], sr));
    expect(back.sampleRate).toBe(sr);
    expect(Math.abs(back.channels[0][1000] - x[1000])).toBeLessThan(1e-4);
    expect(Math.abs(estimateBpm(back.channels, sr) - bpm)).toBeLessThan(2);
    expect(keySimilarity(estimateKey(back.channels, sr), 'Am')).toBeGreaterThanOrEqual(0.5);
  });
});
