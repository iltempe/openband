import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { runTests, tracksOf } from './engine';
import { TestParseError, format, parseTest } from './parse';
import type { Metric } from './types';

const SPEC = ['in ritornello: voce.lufs >= chitarre.lufs + 3 dB', 'master.lufs_i tra -10 e -8', 'master.true_peak <= -1', 'basso: mono sotto 120 Hz', 'basso: note tra E1 e G3', 'voce vs chitarre: masking 1–4 kHz <= 0.3', 'rispetto a approvata: ogni traccia ± 1.5 dB per sezione'];
const song = (o: Partial<Project> = {}): Project => ({ version: 3, name: 'S', bpm: 120, key: 'C', tracks: [], regions: [], loop: { enabled: false, start: 0, end: 16 }, masterVolume: 0.8, metronome: false, ...o });
const track = (id: string, name: string) => ({ id, name, kind: 'instrument', instrument: 'x' }) as never;
const notes = (pitches: [number, number, number][]) => pitches.map(([pitch, start, duration], i) => ({ id: `n${i}`, pitch, start, duration, velocity: 0.8 }));

describe('the text form', () => {
  it.each(SPEC)('parses and comes back the same: %s', (line) => {
    const t = parseTest(line, 'x');
    const again = parseTest(format(t), 'x');
    expect(again.assert).toEqual(t.assert);
    expect(again.scope).toEqual(t.scope);
    expect(format(again)).toBe(format(t));
  });
  it('understands English', () => {
    expect(parseTest('in chorus: vocals.lufs >= guitars.lufs + 3 dB').assert).toEqual(parseTest('in ritornello: voce.lufs >= guitars.lufs + 3 dB').assert);
    expect(parseTest('master.lufs_i between -10 and -8').assert).toEqual(parseTest('master.lufs_i tra -10 e -8').assert);
    expect(parseTest('compared to approved: every track ± 1.5 dB per section').assert).toMatchObject({ kind: 'baseline', baseline: 'approved', tolerance: 1.5 });
  });
  it('turns the words into a clear structure', () => {
    expect(parseTest('in ritornello: voce.lufs >= chitarre.lufs + 3 dB')).toMatchObject({ scope: { sections: ['chorus'] }, assert: { op: '>=', margin: 3, left: { of: { role: 'vocal' }, measure: 'lufs_i' }, right: { of: { track: 'chitarre' } } } });
    expect(parseTest('basso: note tra E1 e G3').assert).toMatchObject({ rule: 'pitch_range', args: { low: 28, high: 55 } });
    expect(parseTest('voce vs chitarre: masking 1–4 kHz <= 0.3').assert).toMatchObject({ left: { band: [1000, 4000] } });
  });
  it('says where the error is', () => {
    expect(() => parseTest('master.volume <= 1')).toThrow(TestParseError);
    expect(() => parseTest('master.volume <= 1')).toThrow(/Unknown measure "volume" \(column \d+\)/);
    expect(() => parseTest('mono sotto 120 Hz')).toThrow(/which track/);
    expect(() => parseTest('boh')).toThrow(/understand/);
  });
});

describe('the engine', () => {
  const withTests = (lines: string[], o: Partial<Project>) => song({ ...o, tests: lines.map((l, i) => parseTest(l, `t${i}`)) });
  it('finds tracks by role, by name, and across singular and plural', () => {
    const p = song({ tracks: [track('a', 'Chitarra 2'), track('b', 'Voce')] });
    expect(tracksOf(p, { track: 'chitarre' }).map((t) => t.id)).toEqual(['a']);
    expect(tracksOf(p, { role: 'vocal' }).map((t) => t.id)).toEqual(['b']);
  });
  it('symbolic: a bass note under E1 fails, at its beat', () => {
    const p = withTests(['basso: note tra E1 e G3'], { tracks: [track('b', 'Basso')], regions: [{ id: 'r', trackId: 'b', name: '', start: 8, length: 4, notes: notes([[40, 0, 1], [20, 2, 1]]) }] });
    const [r] = runTests(p).results;
    expect(r).toMatchObject({ pass: false, value: 20, where: { from_beat: 10 } });
  });
  it('symbolic: key, overlaps and polyphony', () => {
    const regions = [{ id: 'r', trackId: 'k', name: '', start: 0, length: 4, notes: notes([[60, 0, 2], [61, 1, 2], [64, 1, 1]]) }];
    const p = withTests(['keys: in key', 'keys: no overlaps', 'keys: polyphony <= 2', 'keys: polyphony <= 3'], { tracks: [track('k', 'Keys')], regions });
    expect(runTests(p).results.map((r) => r.pass)).toEqual([false, false, false, true]);
  });
  it('a test scoped to a section only looks there', () => {
    const sections = [{ id: 's', name: 'Rit', kind: 'chorus' as const, start: 8, length: 8 }];
    const p = withTests(['in ritornello: basso: note tra E1 e G3'], { tracks: [track('b', 'Basso')], sections, regions: [{ id: 'r', trackId: 'b', name: '', start: 0, length: 4, notes: notes([[20, 0, 1]]) }] });
    expect(runTests(p).results[0]).toMatchObject({ pass: true });
    p.regions[0].start = 8;
    expect(runTests(p).results[0]).toMatchObject({ pass: false, where: { section_id: 's' } });
  });
  it('without audio, audio tests are skipped and not failed', () => {
    const [r] = runTests(withTests(['master.true_peak <= -1'], {})).results;
    expect(r).toMatchObject({ pass: true, skipped: true });
  });
  it('compares measures with a margin, section by section, and names the failing one', () => {
    const sections = [{ id: 'a', name: 'R1', kind: 'chorus' as const, start: 0, length: 8 }, { id: 'b', name: 'R2', kind: 'chorus' as const, start: 8, length: 8 }];
    const p = withTests(['in ritornello: voce.lufs >= chitarre.lufs + 3 dB'], { sections });
    const measure = (m: Metric, s: { id: string } | null) => (typeof m.of === 'object' && 'role' in m.of ? (s?.id === 'b' ? -13 : -10) : -14);
    const [r] = runTests(p, { measure: measure as never }).results;
    expect(r).toMatchObject({ pass: false, value: -13, expected: '>= -11', where: { section_id: 'b' } });
  });
  it('baseline: only the changed track, only where it changed', () => {
    const sections = [{ id: 'a', name: 'V', kind: 'verse' as const, start: 0, length: 8 }, { id: 'b', name: 'R', kind: 'chorus' as const, start: 8, length: 8 }];
    const tracks = [track('x', 'Basso'), track('y', 'Keys')];
    const approved = song({ tracks, sections });
    const p = withTests(['compared to approved: every track ± 1.5 dB'], { tracks, sections });
    const measure = (m: Metric, s: { id: string } | null, prj: Project) => (prj === p && (m.of as { track: string }).track === 'x' && s?.id === 'b' ? -8 : -12);
    const r = runTests(p, { measure: measure as never, approved }).results;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ pass: false, value: 4, where: { track_id: 'x', section_id: 'b' } });
  });
});
