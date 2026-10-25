// Session mode (SPEC v0.6 G4): bar scores, the comp that avoids the bars with mistakes, the audio comp,
// and a command said during a take silenced in it.
import { describe, expect, it } from 'vitest';
import { audioBarScores, chooseComp, compAudio, midiBarScores, onsets, silenceSpans, takeScore } from './score';

const SR = 16000;
const SPB = 0.5; // 120 BPM: 2 s a bar
const tone = (midi: number, seconds: number, cents = 0, gain = 0.3) => Float32Array.from({ length: seconds * SR }, (_, i) => gain * Math.sin((2 * Math.PI * 440 * 2 ** ((midi - 69 + cents / 100) / 12) * i) / SR));

describe('session scoring', () => {
  it('in tune beats out of tune, against the guide', () => {
    const guide = [{ start: 0, end: 4, pitch: 64 }];
    const good = audioBarScores(tone(64, 4), SR, { bars: 2, spb: SPB, guide });
    const sharp = audioBarScores(tone(64, 4, 70), SR, { bars: 2, spb: SPB, guide });
    expect(good[0].cents).toBeLessThan(10);
    expect(sharp[0].cents).toBeGreaterThan(55);
    expect(good[0].score).toBeGreaterThan(sharp[0].score + 20);
  });

  it('timing: on the sixteenths beats 40 ms late; clipping and silence cost', () => {
    const clicks = (late: number) => {
      const x = new Float32Array(4 * SR);
      for (let b = 0; b < 8; b++) for (let i = 0; i < 400; i++) x[Math.round((b * SPB + late) * SR) + i] = 0.5 * Math.sin(i / 3) * Math.exp(-i / 120);
      return x;
    };
    expect(onsets(clicks(0), SR).length).toBe(8);
    const on = audioBarScores(clicks(0), SR, { bars: 2, spb: SPB });
    const late = audioBarScores(clicks(0.04), SR, { bars: 2, spb: SPB });
    expect(on[0].timingMs).toBeLessThan(12);
    expect(late[0].timingMs).toBeGreaterThan(25);
    expect(on[0].score).toBeGreaterThan(late[0].score);
    const hot = tone(64, 4, 0, 1.4).map((v) => Math.max(-1, Math.min(1, v)));
    expect(audioBarScores(hot, SR, { bars: 2, spb: SPB })[0].clipped).toBeGreaterThan(1000);
    const half = new Float32Array(4 * SR);
    half.set(tone(64, 2));
    expect(audioBarScores(half, SR, { bars: 2, spb: SPB })[1]).toMatchObject({ silent: true, score: 5 });
  });

  it('MIDI takes: timing and notes out of the key', () => {
    const cMajor = new Set([0, 2, 4, 5, 7, 9, 11]);
    const s = midiBarScores([{ start: 0, pitch: 60 }, { start: 1, pitch: 62 }, { start: 4.1, pitch: 61 }], { bars: 2, spb: SPB, scale: cMajor });
    expect(s[0].score).toBe(100);
    expect(s[1].outOfKey).toBe(1);
    expect(s[1].score).toBeLessThan(80);
  });

  it('five passes with simulated flubs: the comp picks, bar by bar, takes without one', () => {
    const scores = Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => ({ score: 80, cents: null, timingMs: null, clipped: 0, silent: false })));
    // Take 3 is the best in general, but has a flub in bar 2; take 5 has one in bar 4.
    scores[2] = scores[2].map((b) => ({ ...b, score: 90 }));
    const marks = Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => ({ flubs: 0, goods: 0 })));
    marks[2][1].flubs = 1;
    marks[4][3].flubs = 1;
    marks[0][1].goods = 1;
    const pick = chooseComp(scores, marks);
    expect(pick).toEqual([2, 0, 2, 2]);
    for (const [bar, take] of pick.entries()) expect(marks[take][bar].flubs).toBe(0);
    expect(takeScore(scores[2], marks[2])).toBeLessThan(90);
  });

  it('the audio comp joins bars with short crossfades', () => {
    const bar = 1000;
    const takes = [1, 2, 3].map((v) => new Float32Array(3 * bar).fill(v));
    const c = compAudio(takes, [0, 2, 1], bar, 100);
    expect([c[10], c[1500], c[2900]]).toEqual([1, 3, 2]);
    // Smooth across the bar line: no step bigger than the crossfade allows.
    let step = 0;
    for (let i = 1; i < c.length; i++) step = Math.max(step, Math.abs(c[i] - c[i - 1]));
    expect(step).toBeLessThan(0.1);
  });

  it('a command said during a take is silenced in it, with 10 ms fades', () => {
    const x = new Float32Array(SR).fill(0.5);
    silenceSpans(x, [{ from: 4000, to: 8000 }], 160);
    expect(x[3000]).toBe(0.5);
    expect(x[4000]).toBe(0);
    expect(x[7999]).toBe(0);
    expect(x[3920]).toBeGreaterThan(0.2);
    expect(x[3920]).toBeLessThan(0.3);
    expect(x[9000]).toBe(0.5);
  });
});
