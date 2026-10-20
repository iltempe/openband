import { describe, expect, it } from 'vitest';
import { DRUM_STYLES, generateDrums, spansFor, type DrummerOptions } from './drummer';

const base: DrummerOptions = { style: 'rock', complexity: 0.5, loudness: 0.7, swing: 0, fills: 'end_of_section', seed: 42 };
const sig = (notes: { pitch: number; start: number; velocity: number }[]) => notes.map((n) => `${n.pitch}@${n.start}:${n.velocity}`).join(' ');

describe('drummer', () => {
  it('same seed → same part (snapshot), another seed → another part', () => {
    const spans = [{ start: 0, bars: 2, kind: 'verse' as const }];
    const a = generateDrums(spans, base);
    expect(sig(a)).toBe(sig(generateDrums(spans, base)));
    expect(sig(generateDrums(spans, { ...base, seed: 43 }))).not.toBe(sig(a));
    expect(sig(a.slice(0, 12))).toMatchInlineSnapshot(`"36@0:0.758 42@0:0.572 42@0.4937:0.472 42@0.9905:0.566 38@1.0037:0.765 42@1.4998:0.535 36@1.5005:0.652 36@1.7549:0.547 42@1.999:0.547 36@2.0073:0.78 42@2.5011:0.471 38@2.9994:0.704"`);
  });

  it('every style plays a groove with kick and backbeat, inside the bars', () => {
    for (const style of DRUM_STYLES) {
      const n = generateDrums([{ start: 8, bars: 4 }], { ...base, style });
      expect(n.length, style).toBeGreaterThan(20);
      expect(n.some((x) => x.pitch === 36), style).toBe(true);
      expect(n.every((x) => x.start >= 8 - 0.02 && x.start < 24 && x.velocity > 0 && x.velocity <= 1), style).toBe(true);
      // Never two hits of the same drum closer than a 32nd (monophonic voices can't play them).
      for (const seed of [1, 2, 3]) {
        const m = generateDrums([{ start: 0, bars: 4, kind: 'chorus' }], { ...base, style, seed, complexity: 1, fills: 'every_4' });
        const by = new Map<number, number>();
        for (const x of m) {
          const prev = by.get(x.pitch);
          if (prev !== undefined) expect(x.start - prev, `${style} pitch ${x.pitch} at ${x.start}`).toBeGreaterThanOrEqual(0.125 - 1e-9);
          by.set(x.pitch, x.start);
        }
      }
    }
  });

  it('simpler in a verse than in a chorus, louder with loudness, more with complexity', () => {
    const verse = generateDrums([{ start: 0, bars: 8, kind: 'verse' }], { ...base, fills: 'none', complexity: 0.7 });
    const chorus = generateDrums([{ start: 0, bars: 8, kind: 'chorus' }], { ...base, fills: 'none', complexity: 0.7 });
    expect(chorus.length).toBeGreaterThan(verse.length);
    const avg = (n: { velocity: number }[]) => n.reduce((s, x) => s + x.velocity, 0) / n.length;
    expect(avg(generateDrums([{ start: 0, bars: 4 }], { ...base, loudness: 1 }))).toBeGreaterThan(avg(generateDrums([{ start: 0, bars: 4 }], { ...base, loudness: 0.2 })));
    expect(generateDrums([{ start: 0, bars: 8 }], { ...base, complexity: 1, fills: 'none' }).length).toBeGreaterThan(generateDrums([{ start: 0, bars: 8 }], { ...base, complexity: 0, fills: 'none' }).length);
  });

  it('fills at the end of sections (toms for rock), a crash on the next downbeat; swing delays the off-beats', () => {
    const spans = [
      { start: 0, bars: 4, kind: 'verse' as const },
      { start: 16, bars: 4, kind: 'chorus' as const },
    ];
    const n = generateDrums(spans, base);
    const toms = n.filter((x) => [45, 48, 50].includes(x.pitch));
    expect(toms.length).toBeGreaterThan(0);
    expect(toms.every((x) => (x.start >= 15 && x.start < 16) || (x.start >= 31 && x.start < 32) || (x.start >= 14 && x.start < 16) || (x.start >= 30 && x.start < 32))).toBe(true);
    expect(n.some((x) => x.pitch === 49 && Math.abs(x.start - 16) < 0.02)).toBe(true);
    const straight = generateDrums([{ start: 0, bars: 1 }], { ...base, style: 'funk', fills: 'none', complexity: 0 });
    const swung = generateDrums([{ start: 0, bars: 1 }], { ...base, style: 'funk', fills: 'none', complexity: 0, swing: 1 });
    const offStraight = straight.filter((x) => x.pitch === 42 && Math.abs((x.start * 4) % 2 - 1) < 0.1);
    const offSwung = swung.filter((x) => x.pitch === 42).map((x) => x.start).filter((t) => (t * 4) % 1 > 0.2);
    expect(offStraight.length).toBeGreaterThan(0);
    expect(offSwung.length).toBeGreaterThan(0);
  });

  it('spans follow the sections in a range', () => {
    const secs = [
      { start: 0, length: 16, kind: 'verse' as const },
      { start: 16, length: 16, kind: 'chorus' as const },
    ];
    expect(spansFor(secs, 8, 32)).toEqual([
      { start: 8, bars: 2, kind: 'verse' },
      { start: 16, bars: 4, kind: 'chorus' },
    ]);
    expect(spansFor([], 0, 16)).toEqual([{ start: 0, bars: 4 }]);
  });
});
