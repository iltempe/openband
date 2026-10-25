// Draw the song (G2): from an 8-bar loop and an energy curve to a whole arrangement.
import { describe, expect, it } from 'vitest';
import type { Note, Project, Region } from '../types';
import { emptyProject, makeTrack } from '../store';
import { parseChord } from '../music';
import { generateDrums } from '../generate/drummer';
import { arrange, segment } from './arrange';
import { barsFor, correlation, curveAt, measureEnergy, shapeCurve } from './energy';

let k = 0;
const n = (pitch: number, start: number, duration: number, velocity = 0.8): Note => ({ id: `u${k++}`, pitch, start, duration, velocity });

/** The fixture: an 8-bar loop with drums (the drummer's), bass, chords and a lead, in A minor. */
function loop(handDrums = false): Project {
  const p = emptyProject();
  p.key = 'Am';
  p.bpm = 100;
  const drums = makeTrack(p, 'drums', 'kit-studio', 'Drums');
  const bass = makeTrack(p, 'instrument', 'sub-bass', 'Bass');
  const keys = makeTrack(p, 'instrument', 'felt-piano', 'Keys');
  const lead = makeTrack(p, 'instrument', 'neon-lead', 'Lead');
  p.tracks = [drums, bass, keys, lead];
  const prog = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'];
  const reg = (id: string, trackId: string, notes: Note[], extra: Partial<Region> = {}): Region => ({ id, trackId, name: id, start: 0, length: 32, notes, ...extra });
  const drumNotes = handDrums
    ? Array.from({ length: 32 }, (_, b) => [n(b % 2 ? 38 : 36, b, 0.25), n(42, b, 0.25), n(42, b + 0.5, 0.25)]).flat()
    : generateDrums([{ start: 0, bars: 8 }], { style: 'pop', complexity: 0.5, loudness: 0.6, swing: 0, fills: 'none', seed: 3 }).map((x, i) => ({ ...x, id: `d${i}` }));
  p.regions = [
    reg('drums', drums.id, drumNotes, handDrums ? {} : { drummer: { style: 'pop', complexity: 0.5, loudness: 0.6, swing: 0, fills: 'none', seed: 3 } }),
    reg('bass', bass.id, prog.flatMap((c, i) => [n(parseChord(c, 2)[0], i * 4, 1.5), n(parseChord(c, 2)[0], i * 4 + 2, 1.5)])),
    reg('chords', keys.id, prog.flatMap((c, i) => parseChord(c, 4).map((pitch) => n(pitch, i * 4, 3.9, 0.6)))),
    reg('lead', lead.id, prog.flatMap((c, i) => [n(parseChord(c, 5)[0], i * 4, 1), n(parseChord(c, 5)[1], i * 4 + 1, 1), n(parseChord(c, 5)[2], i * 4 + 2, 2)])),
  ];
  return p;
}

const strip = (p: Project) => JSON.stringify(p, (key, v) => (key === 'id' || key === 'trackId' || key === 'sampleId' ? undefined : v));

describe('energy curves (G2)', () => {
  it('shapes: pop has its peaks on the choruses; the length in bars from minutes and tempo', () => {
    const c = shapeCurve('pop', 64);
    expect(c.length_bars).toBe(64);
    expect(curveAt(c, 1)).toBeLessThan(0.3);
    expect(Math.max(...Array.from({ length: 64 }, (_, b) => curveAt(c, b + 1)))).toBe(1);
    expect(barsFor(210, 92)).toBe(80);
  });

  it('measures the loop: every bar busy, the same all along', () => {
    const m = measureEnergy(loop());
    expect(m).toHaveLength(8);
    expect(Math.min(...m)).toBeGreaterThan(0.5);
    expect(Math.max(...m) - Math.min(...m)).toBeLessThan(0.1);
  });

  it('cuts a curve into sections of 4/8/16 bars with intro, verse, chorus and outro', () => {
    const segs = segment(shapeCurve('pop', 64));
    expect(segs.reduce((a, s) => a + s.bars, 0)).toBe(64);
    for (const s of segs) expect(s.bars % 4).toBe(0);
    const kinds = segs.map((s) => s.kind);
    expect(kinds[0]).toBe('intro');
    expect(kinds.at(-1)).toBe('outro');
    expect(kinds).toContain('verse');
    expect(kinds.filter((x) => x === 'chorus').length).toBeGreaterThanOrEqual(2);
  });
});

describe('arrange from energy (G2)', () => {
  for (const shape of ['pop', 'slow_build', 'edm_drop', 'ballad'] as const) {
    it(`from an 8-bar loop to a ${shape} song that follows the curve (correlation > 0.7)`, () => {
      const a = arrange(loop(), { curve: shapeCurve(shape, 64), seed: 4 });
      expect(a.sections.reduce((s, x) => s + x.bars, 0)).toBe(64);
      const kinds = new Set(a.sections.map((s) => s.kind));
      for (const k2 of ['verse', 'chorus', 'outro']) expect(kinds.has(k2 as never)).toBe(true);
      expect(a.correlation).toBeGreaterThan(0.7);
      expect(a.project.sections).toHaveLength(a.sections.length);
      expect(a.project.sections!.every((s) => !!s.color)).toBe(true); // coloured like sections added by hand
      console.log(`${shape}: ${a.sections.map((s) => `${s.name}(${s.bars})`).join(' ')} · r = ${a.correlation} · ${a.transitions.map((t) => `${t.kind}@${t.bar}`).join(' ')} · ending ${a.ending}`);
    });
  }

  it('the pop song has an intro, and the intro is quiet: harmony only', () => {
    const a = arrange(loop(), { curve: shapeCurve('pop', 64), seed: 1 });
    expect(a.sections[0].kind).toBe('intro');
    expect(a.sections[0].layers).toEqual(['Keys']);
    const chorus = a.sections.find((s) => s.kind === 'chorus')!;
    expect(chorus.layers).toEqual(expect.arrayContaining(['Drums', 'Bass', 'Keys', 'Lead']));
  });

  it('the same seed gives the same song', () => {
    const c = shapeCurve('pop', 48);
    const base = loop();
    expect(strip(arrange(base, { curve: c, seed: 9 }).project)).toBe(strip(arrange(base, { curve: c, seed: 9 }).project));
  });

  it("never changes the notes of the user's regions (hand-written drums too)", () => {
    for (const hand of [false, true]) {
      const before = loop(hand);
      const a = arrange(before, { curve: shapeCurve('pop', 64), seed: 2 });
      for (const r of before.regions) {
        if (!hand && r.id === 'drums') continue; // the drummer's part is generated: it is played again
        const same = a.project.regions.filter((x) => x.trackId === r.trackId && JSON.stringify(x.notes.map(({ id: _i, ...rest }) => rest)) === JSON.stringify(r.notes.map(({ id: _i, ...rest }) => rest)));
        expect(same.length).toBeGreaterThan(0);
        // The original region itself is still there, with its very notes.
        expect(a.project.regions.find((x) => x.id === r.id)?.notes).toEqual(r.notes);
      }
    }
  });

  it('transitions where the energy jumps, on a track of their own; a stop before a big drop', () => {
    const a = arrange(loop(), { curve: shapeCurve('edm_drop', 64), seed: 1 });
    const kinds = a.transitions.map((t) => t.kind);
    expect(kinds).toContain('riser');
    expect(kinds).toContain('impact');
    const fx = a.project.tracks.find((t) => t.name === 'FX transitions')!;
    expect(fx.kind).toBe('audio');
    expect(a.project.regions.filter((r) => r.trackId === fx.id).every((r) => r.audio?.sampleId.startsWith('transition:'))).toBe(true);
  });

  it('the second verse has one layer more than the first (here the drums come in)', () => {
    const a = arrange(loop(), { curve: shapeCurve('pop', 64), seed: 1 });
    const verses = a.sections.filter((s) => s.kind === 'verse');
    expect(verses.length).toBeGreaterThanOrEqual(2);
    expect(verses[0].layers).not.toContain('Drums');
    expect([...verses[1].layers].sort()).toEqual([...verses[0].layers, 'Drums'].sort());
  });

  it('when every track already plays, the second verse gets a busier groove', () => {
    const p = loop();
    p.tracks = p.tracks.filter((t) => t.name !== 'Lead');
    const curve = { points: [{ bar: 1, energy: 0.7 }, { bar: 8, energy: 0.7 }, { bar: 9, energy: 0.95 }, { bar: 16, energy: 0.95 }, { bar: 17, energy: 0.7 }, { bar: 24, energy: 0.7 }, { bar: 25, energy: 0.95 }, { bar: 32, energy: 0.95 }], length_bars: 32 };
    const a = arrange(p, { curve, seed: 1 });
    const drums = a.project.regions.filter((r) => r.drummer && /Verse/.test(r.name));
    expect(drums.length).toBe(2);
    expect(drums[1].drummer!.complexity).toBeGreaterThan(drums[0].drummer!.complexity);
  });

  it('the correlation helper', () => {
    expect(correlation([0, 1, 2, 3], [1, 3, 5, 7])).toBeCloseTo(1, 6);
    expect(correlation([0, 1, 2, 3], [3, 2, 1, 0])).toBeCloseTo(-1, 6);
  });
});

describe('transitions, synthesized (G2)', () => {
  it('a riser grows and rises, a downlifter falls, an impact hits first; peaks at −3 dBFS; always the same', async () => {
    const { synthTransition } = await import('./transitions');
    const rms = (x: Float32Array, a: number, b: number) => Math.sqrt(x.slice(Math.floor(a * x.length), Math.floor(b * x.length)).reduce((s, v) => s + v * v, 0) / (x.length * (b - a)));
    const riser = synthTransition('riser', 2, 24000);
    expect(riser.length).toBe(48000);
    expect(rms(riser, 0.75, 1)).toBeGreaterThan(rms(riser, 0, 0.25) * 4);
    const down = synthTransition('downlifter', 2, 24000);
    expect(rms(down, 0, 0.25)).toBeGreaterThan(rms(down, 0.75, 1) * 4);
    const impact = synthTransition('impact', 1, 24000);
    expect(rms(impact, 0, 0.2)).toBeGreaterThan(rms(impact, 0.6, 1) * 3);
    const cym = synthTransition('reverse_cymbal', 1, 24000);
    expect(rms(cym, 0.8, 1)).toBeGreaterThan(rms(cym, 0, 0.2) * 3);
    for (const x of [riser, down, impact, cym]) expect(Math.max(...x.map(Math.abs))).toBeCloseTo(0.708, 3);
    expect(synthTransition('riser', 2, 24000)).toEqual(riser);
  });
});
