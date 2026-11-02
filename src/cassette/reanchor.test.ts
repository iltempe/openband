import { describe, expect, it } from 'vitest';
import type { Project, Section } from '../types';
import { anchorOf, reanchor, secondsToBeat } from './reanchor';

const sec = (id: string, kind: Section['kind'], start: number, length: number): Section => ({ id, name: id, kind, start, length });
const note = (start: number, pitch: number) => ({ id: `n${start}${pitch}`, pitch, start, duration: 1, velocity: 1 });
const phrase = (start: number) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => note(start + i, 60 + i));
const song = (sections: Section[], notes: ReturnType<typeof note>[]): Project => ({ version: 3, name: 'S', bpm: 120, key: 'C', tracks: [], regions: [{ id: 'r', trackId: 't', name: '', start: 0, length: 200, notes }], sections, loop: { enabled: false, start: 0, end: 16 }, masterVolume: 1, metronome: false });

const base = () => song([sec('v', 'verse', 0, 16), sec('c1', 'chorus', 16, 16), sec('b', 'bridge', 32, 8), sec('c2', 'chorus', 40, 16)], [...phrase(20), ...phrase(44)]);

describe('reanchor', () => {
  it('turns seconds into beats', () => expect(secondsToBeat({ bpm: 120, offsetS: 0.5 }, 2.5)).toBe(4));
  it('stays where it is when nothing changed', () => {
    const p = base();
    expect(reanchor(anchorOf(p, 'v', 45), p, p)).toEqual({ beat: 45, confidence: 1 });
  });
  it('a moved bridge: the pin follows the second chorus', () => {
    const p = base();
    const q = song([sec('v', 'verse', 0, 16), sec('b', 'bridge', 16, 8), sec('c1', 'chorus', 24, 16), sec('c2', 'chorus', 40, 16)], [...phrase(28), ...phrase(44)]);
    expect(reanchor(anchorOf(p, 'v', 21), p, q)).toEqual({ beat: 29, confidence: 1 });
  });
  it('a chorus four bars longer: the pin stays on the same phrase', () => {
    const p = base();
    const q = song([sec('v', 'verse', 0, 16), sec('c1', 'chorus', 16, 32), sec('b', 'bridge', 48, 8), sec('c2', 'chorus', 56, 16)], [...phrase(36), ...phrase(60)]);
    expect(reanchor(anchorOf(p, 'v', 21), p, q)).toEqual({ beat: 37, confidence: 1 });
  });
  it('a removed bridge is an orphan', () => {
    const p = base();
    const q = song([sec('v', 'verse', 0, 16), sec('c1', 'chorus', 16, 16)], phrase(20));
    expect(reanchor(anchorOf(p, 'v', 34), p, q)).toEqual({ orphan: true });
  });
  it('a change of tempo changes nothing: the place is in beats', () => {
    const p = base();
    expect(reanchor(anchorOf(p, 'v', 45), p, { ...p, bpm: 90 })).toEqual({ beat: 45, confidence: 1 });
  });
  it('rewritten notes in a longer section fall back on the proportion, and say so', () => {
    const p = base();
    const q = song([sec('c1', 'chorus', 16, 32)], []);
    expect(reanchor(anchorOf(p, 'v', 24), p, q)).toEqual({ beat: 32, confidence: 0.5 });
  });
  it('finds a section by kind and order when ids changed', () => {
    const p = base();
    const q = song([sec('x', 'chorus', 0, 16), sec('y', 'chorus', 16, 16)], []);
    expect(reanchor(anchorOf(p, 'v', 41), p, q)).toMatchObject({ beat: 17 });
  });
});
