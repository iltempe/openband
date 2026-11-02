import { describe, expect, it } from 'vitest';
import { Gate } from './gate.mjs';

const SR = 1000;
const chunk = (seconds: number, amp: number, channels = 2) => {
  const a = new Float32Array(Math.round(seconds * SR) * channels);
  for (let i = 0; i < a.length; i += channels) a[i] = amp * (i % 4 ? 1 : -1);
  return a;
};
const LOUD = 0.2;
const run = (g: Gate, ...parts: [number, number][]) => parts.flatMap(([s, amp]) => g.push(chunk(s, amp)));
const gate = () => new Gate({ sampleRate: SR, channels: 2, preRollS: 5 });

describe('the session gate', () => {
  it('starts after 2 s of sound, with the pre-roll before it', () => {
    const ev = run(gate(), [10, 0], [3, LOUD]);
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('start');
    expect(ev[0].at).toBe(5000);
  });
  it('does not start on a door slam', () => {
    expect(run(gate(), [5, 0], [1, LOUD], [5, 0], [1, LOUD], [5, 0])).toEqual([]);
  });
  it('a dip shorter than a quarter of a second does not restart the count', () => {
    expect(run(gate(), [1.2, LOUD], [0.1, 0], [1.2, LOUD]).map((e) => e.type)).toEqual(['start']);
  });
  it('a sound just under the threshold keeps a running session going (hysteresis)', () => {
    const g = gate();
    run(g, [3, LOUD]);
    const nearly = 10 ** (-43 / 20);
    expect(run(g, [120, nearly]).map((e) => e.type)).toEqual([]);
  });
  it('short pauses do not cut; a pause over 8 s cuts in its middle', () => {
    const g = gate();
    run(g, [10, LOUD]);
    expect(run(g, [5, 0], [10, LOUD])).toEqual([]);
    const ev = run(g, [10, 0], [3, LOUD]);
    expect(ev.map((e) => e.type)).toEqual(['split']);
    expect(Math.abs(ev[0].at - 30000)).toBeLessThan(100);
  });
  it('ends after 90 s of silence, at the last sound', () => {
    const g = gate();
    const ev = run(g, [5, LOUD], [100, 0]);
    expect(ev.map((e) => e.type)).toEqual(['start', 'end']);
    expect(Math.abs(ev[1].at - 5000)).toBeLessThan(100);
  });
  it('hears any channel, whichever one plays', () => {
    const g = gate();
    const right = new Float32Array(SR * 6);
    for (let i = 1; i < right.length; i += 2) right[i] = LOUD;
    expect(g.push(right).map((e) => e.type)).toEqual(['start']);
  });
  it('gives the same answer however the audio is cut in chunks', () => {
    const whole = gate().push(chunk(8, LOUD));
    const g = gate();
    const parts = Array.from({ length: 80 }, () => g.push(chunk(0.1, LOUD))).flat();
    expect(parts).toEqual(whole);
  });
  it('the button forces it, whatever the level', () => {
    const g = gate();
    run(g, [1, 0]);
    expect(g.force(true)?.type).toBe('start');
    expect(g.force(true)).toBeNull();
    expect(g.force(false)?.type).toBe('end');
  });
});
