import { describe, expect, it } from 'vitest';
import { audioToNotes, quantizeNotes, snapToScale, yinTrack } from './pitchtrack';
import { scalePitchClasses } from './key';

const SR = 44100;
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** A sequence of tones (with a short attack/release so onsets are clean); null = silence. */
function tones(seq: [number | null, number][], vibratoCents = 0): Float32Array {
  const total = seq.reduce((s, [, d]) => s + d, 0);
  const x = new Float32Array(Math.round(total * SR));
  let t0 = 0;
  let phase = 0;
  for (const [midi, dur] of seq) {
    const n = Math.round(dur * SR);
    const start = Math.round(t0 * SR);
    for (let i = 0; i < n; i++) {
      if (midi === null) continue;
      const t = i / SR;
      const f = hz(midi) * Math.pow(2, (vibratoCents / 1200) * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * f) / SR;
      const env = Math.min(1, i / (0.005 * SR), (n - i) / (0.01 * SR));
      x[start + i] = 0.4 * env * (Math.sin(phase) + 0.3 * Math.sin(2 * phase));
    }
    t0 += dur;
  }
  return x;
}

describe('YIN pitch tracking', () => {
  it('finds the pitch of steady tones', () => {
    for (const midi of [45, 57, 64, 72, 81]) {
      const frames = yinTrack(tones([[midi, 0.4]]), SR).filter((f) => f.midi !== null);
      const mid = frames[Math.floor(frames.length / 2)].midi!;
      expect(Math.abs(mid - midi)).toBeLessThan(0.1);
    }
  });

  it('is silent on silence', () => {
    expect(yinTrack(new Float32Array(SR / 2), SR).every((f) => f.midi === null)).toBe(true);
  });
});

describe('audio → MIDI notes', () => {
  it('turns a melody of sines into the right notes, onsets within 20 ms', () => {
    // A3 C4 E4 G4 A4, with 50 ms gaps, then a legato step to B4.
    const seq: [number | null, number][] = [[57, 0.35], [null, 0.05], [60, 0.35], [null, 0.05], [64, 0.35], [null, 0.05], [67, 0.35], [null, 0.05], [69, 0.4], [71, 0.4]];
    const notes = audioToNotes(tones(seq), SR);
    expect(notes.map((n) => n.pitch)).toEqual([57, 60, 64, 67, 69, 71]);
    const truth = [0, 0.4, 0.8, 1.2, 1.6, 2.0];
    notes.forEach((n, i) => expect(Math.abs(n.start - truth[i])).toBeLessThan(0.02));
  });

  it('keeps a note with ±30 cent vibrato as one note', () => {
    const notes = audioToNotes(tones([[64, 1.2]], 30), SR);
    expect(notes).toHaveLength(1);
    expect(notes[0].pitch).toBe(64);
  });

  it('drops blips shorter than 80 ms', () => {
    const notes = audioToNotes(tones([[60, 0.4], [null, 0.1], [67, 0.05], [null, 0.1], [64, 0.4]]), SR);
    expect(notes.map((n) => n.pitch)).toEqual([60, 64]);
  });

  it('snaps to the key and quantizes with strength', () => {
    const scale = scalePitchClasses('C');
    expect(snapToScale(61, scale)).toBe(60);
    expect(snapToScale(66, scale)).toBe(65);
    expect(snapToScale(64, scale)).toBe(64);
    const q = quantizeNotes([{ start: 0.1, duration: 0.9 }], 0.25, 1);
    expect(q[0]).toEqual({ start: 0, duration: 1 });
    expect(quantizeNotes([{ start: 0.1, duration: 0.9 }], 0.25, 0.5)[0].start).toBeCloseTo(0.05);
  });
});
