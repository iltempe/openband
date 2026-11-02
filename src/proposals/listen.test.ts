import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { duckedCopy, levelMatchDb, voteMeaning } from './listen';

describe('listening', () => {
  it('turns down only what did not change', () => {
    const p = { tracks: [{ id: 'a', volume: 1 }, { id: 'b', volume: 1 }] } as Project;
    const d = duckedCopy(p, new Set(['a']), -12);
    expect(d.tracks[0].volume).toBe(1);
    expect(d.tracks[1].volume).toBeCloseTo(0.251, 2);
    expect(p.tracks[1].volume).toBe(1);
  });
  it('matches the level, and survives silence', () => {
    expect(levelMatchDb(-14, -10)).toBe(-4);
    expect(levelMatchDb(-Infinity, -10)).toBe(0);
  });
  it('turns a blind vote back into what it means', () => {
    expect(voteMeaning('a', 'base')).toBe('base');
    expect(voteMeaning('b', 'base')).toBe('head');
    expect(voteMeaning('b', 'head')).toBe('base');
  });
});
