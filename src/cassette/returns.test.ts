import { describe, expect, it } from 'vitest';
import { heatmap } from './returns';

describe('the heat map', () => {
  it('counts reactions where they are, and what was heard', () => {
    const r = [{ items: [{ kind: 'reaction' as const, t: 50, label: 'x' }, { kind: 'comment' as const, t: 50.5, text: 'y' }, { kind: 'listen' as const, segments: [[0, 49]] as [number, number][], completed: false, plays: 1 }] }];
    const { hot, heard } = heatmap(r, 100, 10);
    expect(hot[5]).toBe(2);
    expect(heard.slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
    expect(heard[6]).toBe(0);
  });
});
