import { describe, expect, it } from 'vitest';
import { TabBuffer } from './tabRehearsal';

describe('the browser rehearsal buffer', () => {
  const chunk = (v: number, n = 100) => new Float32Array(n).fill(v);
  it('keeps only what the pre-roll needs until a session opens', () => {
    const b = new TabBuffer(250);
    for (let i = 0; i < 10; i++) b.push(chunk(i / 10));
    b.trim();
    expect(b.frames).toBe(1000);
    expect(b.dropped).toBe(700);
    expect(b.slice(800, 802)[0]).toBeCloseTo(0.8, 3);
  });
  it('cuts across chunks, by absolute position', () => {
    const b = new TabBuffer(1000);
    b.push(chunk(0.1));
    b.push(chunk(0.2));
    const s = b.slice(90, 110);
    expect(s).toHaveLength(20);
    expect(s[9]).toBeCloseTo(0.1, 3);
    expect(s[10]).toBeCloseTo(0.2, 3);
  });
});
