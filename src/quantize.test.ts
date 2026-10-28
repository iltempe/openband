import { describe, expect, it } from 'vitest';
import { gridPoint, moved, quantizeNotes } from './quantize';
import type { Note } from './types';

const n = (start: number, duration = 0.2, pitch = 60): Note => ({ id: `${start}`, pitch, start, duration, velocity: 0.8 });

describe('quantize', () => {
  it('snaps starts and ends to the grid', () => {
    const q = quantizeNotes([n(0.07, 0.4), n(0.52, 0.2), n(0.98, 0.2)], 0, { grid: 0.25 });
    expect(q.map((x) => [x.start, x.duration])).toEqual([
      [0, 0.5],
      [0.5, 0.25],
      [1, 0.25],
    ]);
  });
  it('strength moves part of the way', () => {
    expect(quantizeNotes([n(0.1)], 0, { grid: 0.25, strength: 0.5, ends: false })[0].start).toBeCloseTo(0.05, 6);
    expect(quantizeNotes([n(0.1)], 0, { grid: 0.25, strength: 0 })[0].start).toBeCloseTo(0.1, 6);
  });
  it('swing pushes the off-beat 16ths late', () => {
    expect(gridPoint(0.27, 0.25, 0.33)).toBeCloseTo(0.3325, 6);
    expect(gridPoint(0.49, 0.25, 0.33)).toBeCloseTo(0.5, 6);
    const q = quantizeNotes([n(0), n(0.26), n(0.5), n(0.74)], 0, { grid: 0.25, swing: 0.33, ends: false });
    expect(q.map((x) => x.start)).toEqual([0, 0.3325, 0.5, 0.8325]);
  });
  it('triplets', () => {
    const q = quantizeNotes([n(0.3), n(0.7)], 0, { grid: 1 / 3, ends: false });
    expect(q.map((x) => x.start)).toEqual([0.333333, 0.666667]);
  });
  it("the song's grid, also for a region that starts off it", () => {
    // Region at beat 0.1: a note at its 0.15 is at song beat 0.25.
    expect(quantizeNotes([n(0.17)], 0.1, { grid: 0.25, ends: false })[0].start).toBeCloseTo(0.15, 6);
  });
  it('a note never vanishes, never moves before its region', () => {
    const q = quantizeNotes([n(0.01, 0.05)], 0, { grid: 0.25 });
    expect(q[0].start).toBe(0);
    expect(q[0].duration).toBeGreaterThan(0);
    expect(quantizeNotes([n(0.02)], 1, { grid: 0.5, ends: false })[0].start).toBe(0);
  });
  it('counts what moved', () => {
    const b = [n(0), n(0.1)];
    expect(moved(b, quantizeNotes(b, 0, { grid: 0.25, ends: false }))).toBe(1);
  });
});
