import { describe, expect, it } from 'vitest';
import { beatAfter, beatsUntil, phraseLength, planResponse } from './jam';

const noLoop = { enabled: false, start: 0, end: 16 };
const loop = { enabled: true, start: 16, end: 32 }; // bars 5–8

describe('jam scheduling', () => {
  it('walks the cycle', () => {
    expect(beatsUntil(20, 24, loop)).toBe(4);
    expect(beatsUntil(28, 16, loop)).toBe(4); // wraps
    expect(beatsUntil(28, 20, loop)).toBe(8);
    expect(beatsUntil(28, 40, loop)).toBe(Infinity); // outside the cycle: never reached
    expect(beatsUntil(5, 3, noLoop)).toBe(Infinity);
    expect(beatAfter(28, 6, loop)).toBe(18);
  });

  it('answers on the next bar line, never before the requested window', () => {
    const p = planResponse({ now: 9.2, playing: true, window: 'next_bar', loop: noLoop, length: 4 });
    expect(p).toEqual({ wait: 12 - 9.2, startBeat: 12, slipped: false });
    expect(p.startBeat % 4).toBe(0);
  });

  it('slips to the next bar when the answer arrives too late for this one', () => {
    // 0.2 beats before the bar line, with a 0.5-beat safety lead.
    const p = planResponse({ now: 11.8, playing: true, window: 'next_bar', loop: noLoop, length: 4 });
    expect(p.startBeat).toBe(16);
    expect(p.slipped).toBe(true);
    expect(p.wait).toBeGreaterThanOrEqual(0.5);
  });

  it('waits for the next loop start, and for the following one if too close', () => {
    expect(planResponse({ now: 22, playing: true, window: 'next_loop', loop, length: 8 })).toEqual({ wait: 10, startBeat: 16, slipped: false });
    const late = planResponse({ now: 31.9, playing: true, window: 'next_loop', loop, length: 8 });
    expect(late).toMatchObject({ startBeat: 16, slipped: true });
    expect(late.wait).toBeCloseTo(16.1);
  });

  it('plays a given bar, or the same bar on the next pass of the cycle', () => {
    expect(planResponse({ now: 17, playing: true, window: { bar: 7 }, loop, length: 4 })).toMatchObject({ startBeat: 24, wait: 7, slipped: false });
    // Bar 7 has just gone by: in a cycle it comes back on the next pass (that's still the bar asked for).
    expect(planResponse({ now: 25, playing: true, window: { bar: 7 }, loop, length: 4 })).toMatchObject({ startBeat: 24, wait: 15, slipped: false });
    // Too close to it (0.2 beats): the same bar one pass later.
    const late = planResponse({ now: 23.8, playing: true, window: { bar: 7 }, loop, length: 4 });
    expect(late).toMatchObject({ startBeat: 24, slipped: true });
    expect(late.wait).toBeCloseTo(16.2);
    // Without a cycle a passed bar can't come back: next bar line instead.
    expect(planResponse({ now: 25, playing: true, window: { bar: 7 }, loop: noLoop, length: 4 })).toMatchObject({ startBeat: 28, slipped: true });
  });

  it('never overlaps an answer that is still playing', () => {
    // A previous answer plays for 6 more beats: the next bar line after that.
    const p = planResponse({ now: 9, playing: true, window: 'next_bar', loop: noLoop, length: 4, busyFor: 6 });
    expect(p.startBeat).toBe(16);
    expect(p.wait).toBeGreaterThanOrEqual(6);
    expect(p.startBeat % 4).toBe(0);
  });

  it('lets an answer start right where the previous one ends', () => {
    // The previous answer ends on the bar line at 16 (plus a few ms of scheduling offset).
    const p = planResponse({ now: 12.3, playing: true, window: 'next_bar', loop: noLoop, length: 4, busyFor: 3.74 });
    expect(p).toMatchObject({ startBeat: 16, slipped: false });
  });

  it('starts right away when the transport is stopped', () => {
    expect(planResponse({ now: 8, playing: false, window: 'next_bar', loop: noLoop, length: 4 })).toEqual({ wait: 0, startBeat: 8, slipped: false });
    expect(phraseLength([{ start: 0, duration: 5 }])).toBe(8);
  });
});
