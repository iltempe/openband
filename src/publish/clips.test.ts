import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { frameIndex } from './frames';
import { clipChords, clipNotes, clipRange, loopChannels, suggestClips } from './clips';

const note = (start: number, pitch: number) => ({ id: `n${start}`, pitch, start, duration: 1, velocity: 0.8 });
const song = (): Project => ({ version: 3, name: 'Demo', bpm: 120, key: 'C', masterVolume: 0.8, metronome: false, loop: { enabled: false, start: 0, end: 16 }, tracks: [{ id: 'b', name: 'Bass', kind: 'instrument', instrument: 'x', color: '#f00', mute: false } as never], regions: [{ id: 'r', trackId: 'b', name: '', start: 8, length: 16, notes: [note(0, 40), note(4, 43), note(8, 45)] }], sections: [{ id: 'v', name: 'Verse', kind: 'verse', start: 0, length: 8 }, { id: 'c', name: 'Chorus', kind: 'chorus', start: 8, length: 16 }] });

describe('camera frames', () => {
  it('holds at the ends', () => {
    expect(frameIndex(0.25, 10, 100)).toBe(2);
    expect(frameIndex(-1, 10, 100)).toBe(0);
    expect(frameIndex(99, 10, 100)).toBe(99);
  });
});

describe('clips', () => {
  it('finds the stretch of every source', () => {
    const p = song();
    expect(clipRange(p, { kind: 'section', section_id: 'c' }, 100)).toEqual({ from: 4, to: 12 });
    expect(clipRange(p, { kind: 'range', from_bar: 2, to_bar: 3 }, 100)).toEqual({ from: 2, to: 4 });
    expect(clipRange(p, { kind: 'track', track_id: 'b', context: 'solo' }, 100)).toEqual({ from: 4, to: 12 });
    expect(clipRange(p, { kind: 'song' }, 100, 20)).toEqual({ from: 0, to: 20 });
    expect(() => clipRange(p, { kind: 'section', section_id: 'x' }, 100)).toThrow(/not found/);
  });
  it('a perfect loop ends where it starts', () => {
    const n = 100;
    const c = Float32Array.from({ length: n }, (_, i) => i / n);
    const [out] = loopChannels([c], 20);
    expect(out.length).toBe(80);
    expect(out[0]).toBeCloseTo(c[80]);
    expect(Math.abs(out[79] - out[78])).toBeLessThan(0.02);
    expect(Math.abs(out[0] - out[79])).toBeLessThan(0.02);
  });
  it('gives the notes in clip time, the focus lit', () => {
    const [n] = clipNotes(song(), 4, 12, 'b');
    expect(n).toMatchObject({ t: 0, pitch: 40, on: true });
    expect(clipNotes(song(), 4, 12, 'other')[0].on).toBe(false);
  });
  it('gives chords in clip time', () => expect(clipChords(song(), 4, 12).every((c) => c.t >= -0.001)).toBe(true));
  it('suggests the same moments every time, the chorus first', () => {
    const a = suggestClips(song());
    expect(a).toEqual(suggestClips(song()));
    expect(a[0]).toMatchObject({ source: { kind: 'section', section_id: 'c' }, why: 'the chorus' });
    expect(a[0].hashtags).toContain('#openband');
    expect(a).toMatchSnapshot();
  });
  it('works on a song with no sections', () => {
    const p = song();
    delete p.sections;
    expect(suggestClips(p)[0].source.kind).toBe('range');
  });
});
