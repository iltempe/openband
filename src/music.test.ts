import { describe, expect, it } from 'vitest';
import { normalizeKey, noteName, parseChord, parsePitch } from './music';
import { demoV1Raw, dirtyProjectFixture, emptyProjectFixture } from './__fixtures__/projects';
import { readMidi, writeMidi } from './midi';
import type { Project } from './types';

describe('music theory helpers', () => {
  it('parses pitches from numbers, names and drum names', () => {
    expect(parsePitch(60)).toBe(60);
    expect(parsePitch('C4')).toBe(60);
    expect(parsePitch('F#3')).toBe(54);
    expect(parsePitch('Bb2')).toBe(46);
    expect(parsePitch('kick', true)).toBe(36);
    expect(noteName(61)).toBe('C#4');
  });

  it('builds chords', () => {
    expect(parseChord('C', 4)).toEqual([60, 64, 67]);
    expect(parseChord('Am7', 3)).toEqual([57, 60, 64, 67]);
  });
});

describe('fixtures', () => {
  it('has a real v1 demo export', () => {
    const p = demoV1Raw as Project;
    expect(p.version).toBe(1);
    expect(p.tracks.map((t) => t.name)).toEqual(['Drums', 'Bass', 'Electric piano', 'Pad']);
  });
  it('builds the empty and dirty projects', () => {
    expect(emptyProjectFixture().tracks).toHaveLength(0);
    expect(dirtyProjectFixture().regions.length).toBeGreaterThan(4);
  });
});

describe('MIDI files', () => {
  it('round-trips the demo through a Standard MIDI File', () => {
    const p = demoV1Raw as Project;
    const song = readMidi(writeMidi(p).slice().buffer);
    expect(song.bpm).toBeCloseTo(p.bpm, 1);
    const total = p.regions.reduce((n, r) => n + r.notes.filter((x) => x.start < r.length).length, 0);
    expect(song.parts.reduce((n, part) => n + part.notes.length, 0)).toBe(total);
    expect(song.parts.find((part) => part.channel === 9)?.name).toBe('Drums');
  });
});

describe('normalizeKey', () => {
  it('reads keys the way people write them', () => {
    expect(normalizeKey('D minor')).toBe('Dm');
    expect(normalizeKey('Dm')).toBe('Dm');
    expect(normalizeKey('Bb major')).toBe('Bb');
    expect(normalizeKey('f#m')).toBe('F#m');
    expect(normalizeKey('A# min')).toBe('Bbm');
    expect(normalizeKey('G#')).toBe('Ab');
    expect(normalizeKey('C')).toBe('C');
    expect(normalizeKey('E♭ minor')).toBe('Ebm');
    expect(normalizeKey('H')).toBeNull();
    expect(normalizeKey('lo-fi')).toBeNull();
  });
});
