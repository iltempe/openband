// Ghost notes (G3): the local suggestion engine — fast, in harmony, offline.
import { describe, expect, it, vi } from 'vitest';
import type { Note, Project, Region } from '../types';
import { emptyProject, makeTrack } from '../store';
import { parseChord } from '../music';
import { chordAt, chordPcs, contextOf, suggest } from './engine';
import { Ppm } from './ppm';

let n = 0;
const note = (pitch: number, start: number, duration: number, velocity = 0.8): Note => ({ id: `n${n++}`, pitch, start, duration, velocity });

/** A song in A minor: chords Am F C G (a bar each, twice) on a keys track, and a melody region. */
function song(melody: Note[], opts: { melodyLen?: number; key?: string } = {}) {
  const p: Project = emptyProject();
  p.key = opts.key ?? 'Am';
  p.bpm = 96;
  const keys = makeTrack(p, 'instrument', 'felt-piano', 'Keys');
  const lead = makeTrack(p, 'instrument', 'neon-lead', 'Lead');
  const bass = makeTrack(p, 'instrument', 'sub-bass', 'Bass');
  const drums = makeTrack(p, 'drums', 'kit-studio', 'Drums');
  p.tracks = [keys, lead, bass, drums];
  const prog = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'];
  const chordNotes = prog.flatMap((c, i) => parseChord(c, 4).map((pitch) => note(pitch, i * 4, 4, 0.6)));
  const region = (id: string, trackId: string, notes: Note[], length = 32): Region => ({ id, trackId, name: id, start: 0, length, notes });
  p.regions = [region('chords', keys.id, chordNotes), region('mel', lead.id, melody, opts.melodyLen ?? 32), region('bassline', bass.id, []), region('beat', drums.id, [])];
  return p;
}

// Two bars of melody in A minor (on the chord tones), then nothing.
const MELODY = [note(69, 0, 1), note(72, 1, 1), note(76, 2, 1.5), note(74, 3.5, 0.5), note(72, 4, 1), note(69, 5, 1), note(65, 6, 2)];

describe('ghost notes: the engine (G3)', () => {
  it('reads the chords under the song from the other tracks', () => {
    const ctx = contextOf(song(MELODY), 'mel');
    expect(ctx.chords.slice(0, 4).map((c) => c.chord)).toEqual(['Am', 'F', 'C', 'G']);
    expect(chordPcs(chordAt(ctx, 4)!).sort()).toEqual([0, 5, 9]);
  });

  it('continues a melody: the rest of the bar and the next one, chord tones on the strong beats (≥ 90 %)', () => {
    let strong = 0;
    let inChord = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const p = song(MELODY);
      const { kind, suggestions } = suggest(p, 'mel', { seed });
      expect(kind).toBe('continue');
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      const ctx = contextOf(p, 'mel');
      for (const s of suggestions) {
        expect(Math.min(...s.notes.map((x) => x.start))).toBeGreaterThanOrEqual(8 - 1e-6);
        expect(Math.max(...s.notes.map((x) => x.start + x.duration))).toBeLessThanOrEqual(12 + 1e-6);
        for (const g of s.notes)
          if (g.start % 2 === 0) {
            strong++;
            if (chordPcs(chordAt(ctx, g.start)!).includes(g.pitch % 12)) inChord++;
          }
        expect(s.reasons.length).toBeGreaterThan(0);
      }
    }
    console.log(`ghost notes: ${inChord}/${strong} strong-beat notes are chord tones`);
    expect(inChord / strong).toBeGreaterThanOrEqual(0.9);
  });

  it('is the same for the same seed, and three different ideas', () => {
    const a = suggest(song(MELODY), 'mel', { seed: 7 }).suggestions;
    expect(suggest(song(MELODY), 'mel', { seed: 7 }).suggestions).toEqual(a);
    expect(new Set(a.map((s) => JSON.stringify(s.notes))).size).toBe(a.length);
  });

  it('a bass line under the chords: roots on the downbeats, low', () => {
    const { kind, suggestions } = suggest(song(MELODY), 'bassline');
    expect(kind).toBe('bass');
    expect(suggestions).toHaveLength(3);
    for (const s of suggestions) {
      const downbeats = s.notes.filter((x) => x.start % 4 === 0);
      expect(downbeats.map((x) => x.pitch % 12).slice(0, 4)).toEqual([9, 5, 0, 7]); // A F C G
      expect(Math.max(...s.notes.map((x) => x.pitch))).toBeLessThan(60);
    }
  });

  it('harmonizes a melody: three progressions whose chords hold its strong-beat notes', () => {
    const p = song(MELODY);
    p.regions = p.regions.filter((r) => r.id !== 'chords');
    const { suggestions } = suggest(p, 'mel', { kind: 'harmonize' });
    expect(suggestions).toHaveLength(3);
    expect(new Set(suggestions.map((s) => s.chords!.join(' '))).size).toBe(3);
    for (const s of suggestions) {
      expect(s.newTrack).toBe(true);
      expect(s.chords).toHaveLength(2);
      // Bar 1's downbeat A (69) is in the first chord, bar 2's C (72) in the second.
      const pcsOf = (bar: number) => new Set(s.notes.filter((x) => x.start === bar * 4).map((x) => x.pitch % 12));
      expect(pcsOf(0).has(9)).toBe(true);
      expect(pcsOf(1).has(0)).toBe(true);
    }
    expect(suggestions[0].chords![0]).toBe('Am');
  });

  it('a counter-melody never doubles the melody and moves against it', () => {
    const { suggestions } = suggest(song(MELODY), 'mel', { kind: 'counter' });
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions)
      for (const g of s.notes) {
        const m = MELODY.find((x) => x.start <= g.start && x.start + x.duration > g.start);
        if (m) expect(g.pitch % 12 === m.pitch % 12 && g.pitch === m.pitch).toBe(false);
      }
  });

  it('a new section on the same track: a variation of the motif, same rhythm', () => {
    const p = song(MELODY);
    const lead = p.tracks[1];
    p.regions.push({ id: 'verse2', trackId: lead.id, name: 'Verse 2', start: 32, length: 8, notes: [] });
    const { kind, suggestions } = suggest(p, 'verse2');
    expect(kind).toBe('variation');
    for (const s of suggestions) expect(s.notes.map((x) => x.start)).toEqual(MELODY.map((x) => x.start));
    expect(suggestions[2].reasons[0]).toMatch(/inversion/);
  });

  it('drums: completes the groove, or a fill with a crash after it', () => {
    const p = song(MELODY);
    const beat = p.regions.find((r) => r.id === 'beat')!;
    beat.length = 8;
    beat.notes = [note(36, 0, 0.25), note(42, 0, 0.25), note(42, 0.5, 0.25), note(38, 1, 0.25), note(42, 1.5, 0.25), note(36, 2, 0.25), note(42, 2.5, 0.25), note(38, 3, 0.25), note(42, 3.5, 0.25), note(36, 4, 0.25)];
    const cont = suggest(p, 'beat');
    expect(cont.kind).toBe('continue');
    const groove = cont.suggestions[0].notes;
    expect(groove.filter((x) => x.pitch === 38).map((x) => x.start)).toEqual([5, 7]);
    expect(Math.min(...groove.map((x) => x.start))).toBeGreaterThan(4);
    const fill = suggest(p, 'beat', { kind: 'drum_fill' }).suggestions;
    expect(fill).toHaveLength(3);
    expect(fill[0].notes.filter((x) => x.pitch === 38 && x.start >= 6)).toHaveLength(8);
  });

  it('is instant: 3 suggestions for a 64-note region in < 50 ms (p95)', () => {
    const long = Array.from({ length: 64 }, (_, i) => note([69, 72, 76, 74, 72, 69, 65, 67][i % 8], i * 0.5, 0.5));
    const p = song(long, { melodyLen: 40 });
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      suggest(p, 'mel', { seed: i + 1 });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`ghost notes: p50 ${times[20].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(50);
  });

  it('never leaves the computer: no network while suggesting', () => {
    const f = vi.fn();
    const old = globalThis.fetch;
    globalThis.fetch = f as unknown as typeof fetch;
    try {
      for (const kind of ['continue', 'bass', 'harmonize', 'counter', 'variation', 'drum_fill'] as const) suggest(song(MELODY), kind === 'bass' ? 'bassline' : kind === 'drum_fill' ? 'beat' : 'mel', { kind });
    } finally {
      globalThis.fetch = old;
    }
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the variable-order Markov model', () => {
  it('uses the longest context it has seen, backing off to shorter ones', () => {
    const m = new Ppm(2);
    m.train(['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'd']);
    const after = m.predict(['a', 'b']);
    expect(after.get('c')! > after.get('d')!).toBe(true);
    expect([...m.predict(['zz']).values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });
});
