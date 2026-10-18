import { describe, expect, it } from 'vitest';
import { PhraseSegmenter } from './phrases';

const play = (s: PhraseSegmenter, notes: [number, number, number][], song0 = 0) => {
  for (const [pitch, on, off] of notes) {
    s.noteOn(pitch, 0.8, on, song0 + on);
    s.noteOff(pitch, off);
  }
};

describe('PhraseSegmenter', () => {
  it('closes a phrase only after a bar of silence', () => {
    const s = new PhraseSegmenter();
    play(s, [[60, 0, 0.5], [62, 1, 1.5], [64, 2, 3]]);
    expect(s.poll(3.5)).toBeNull();
    expect(s.poll(6.9)).toBeNull();
    const p = s.poll(7)!;
    expect(p.notes.map((n) => n.pitch)).toEqual([60, 62, 64]);
    expect(p.start_bar).toBe(1);
    expect(s.poll(20)).toBeNull(); // nothing left
  });

  it('does not close while a note is held', () => {
    const s = new PhraseSegmenter();
    s.noteOn(60, 0.8, 0, 0);
    expect(s.poll(10)).toBeNull();
    s.noteOff(60, 10);
    expect(s.poll(14)!.notes[0].duration).toBe(10);
  });

  it('quantizes to sixteenths and keeps the raw start', () => {
    const s = new PhraseSegmenter();
    play(s, [[60, 0.02, 0.5], [67, 1.13, 1.4]]);
    const p = s.poll(10)!;
    expect(p.notes[0]).toMatchObject({ start: 0, raw_start: 0.02, duration: 0.5 });
    expect(p.notes[1]).toMatchObject({ start: 1.25, raw_start: 1.13, duration: 0.25 });
  });

  it('places the phrase in the bar of the song where it began', () => {
    const s = new PhraseSegmenter();
    // Clock 100 corresponds to song beat 17 (bar 5, second beat).
    s.noteOn(60, 0.8, 100, 17);
    s.noteOff(60, 100.5);
    const p = s.poll(105)!;
    expect(p.start_bar).toBe(5);
    expect(p.notes[0].start).toBe(1);
  });

  it('splits two phrases separated by silence', () => {
    const s = new PhraseSegmenter();
    play(s, [[60, 0, 1]]);
    const a = s.poll(5)!;
    play(s, [[72, 8, 9]], 0);
    const b = s.poll(13)!;
    expect(a.notes).toHaveLength(1);
    expect(b.notes[0].pitch).toBe(72);
    expect(b.start_bar).toBe(3);
  });
});
