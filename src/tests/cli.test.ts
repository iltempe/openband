import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { needsAudio, readSong, report, symbolicRun } from './cli';
import { parseTest } from './parse';

const tests = [parseTest('basso: note tra E1 e G3', 'a'), parseTest('master.true_peak <= -1', 'b')];
const song = { version: 3, name: 'S', bpm: 120, key: 'C', tracks: [{ id: 'b', name: 'Basso', kind: 'instrument' }], regions: [{ id: 'r', trackId: 'b', name: '', start: 0, length: 4, notes: [{ id: 'n', pitch: 10, start: 0, duration: 1, velocity: 1 }] }], tests };

describe('openband test', () => {
  it('reads a .json and a .openband, and runs what needs no audio', () => {
    const json = strToU8(JSON.stringify(song));
    expect(readSong(json).name).toBe('S');
    expect(readSong(zipSync({ 'project.json': json })).name).toBe('S');
    const { run } = symbolicRun(json);
    expect(run.results.find((r) => r.testId === 'a')).toMatchObject({ pass: false, value: 10 });
    expect(run.results.find((r) => r.testId === 'b')).toMatchObject({ skipped: true });
  });
  it('knows when it needs a browser', () => {
    expect(needsAudio([tests[0]])).toBe(false);
    expect(needsAudio(tests)).toBe(true);
  });
  it('writes JUnit, escaped, with skipped tests marked', () => {
    const { run } = symbolicRun(strToU8(JSON.stringify(song)));
    const xml = report('a&b', tests, run.results, 'junit');
    expect(xml).toContain('name="a&amp;b" tests="2" failures="1" skipped="1"');
    expect(xml).toContain('<failure message="10, expected 28–55"/>');
    expect(xml).toContain('<skipped/>');
    expect(JSON.parse(report('x', tests, run.results, 'json')).tests).toHaveLength(2);
    expect(report('x', tests, run.results, 'text')).toContain('✗ basso: note tra E1 e G3');
  });
});
