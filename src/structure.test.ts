import { describe, expect, it } from 'vitest';
import { deleteSection, duplicateSection, energyProfile, moveSection, proposeSections, splitRegionAt } from './structure';
import { note, region, track } from './__fixtures__/projects';
import type { Project, Section } from './types';

const sec = (id: string, kind: Section['kind'], startBar: number, bars: number): Section => ({ id, name: id, kind, start: (startBar - 1) * 4, length: bars * 4 });

/** Song: A (bars 1–4) · B (5–8) · C (9–12), one region per section on one track, + automation. */
function song(): Project {
  return {
    version: 2,
    name: 'S',
    bpm: 120,
    key: 'C',
    loop: { enabled: false, start: 0, end: 16 },
    masterVolume: 0.8,
    metronome: false,
    tracks: [track('t1', { automation: { volume: [{ beat: 2, value: 0.1 }, { beat: 18, value: 0.5 }, { beat: 34, value: 0.9 }] } })],
    regions: [region('ra', 't1', 0, 16, [note(60, 0, 1, 0.8, 'a1')]), region('rb', 't1', 16, 16, [note(62, 0, 1, 0.8, 'b1')]), region('rc', 't1', 32, 16, [note(64, 0, 1, 0.8, 'c1')])],
    sections: [sec('A', 'verse', 1, 4), sec('B', 'chorus', 5, 4), sec('C', 'bridge', 9, 4)],
  };
}
const order = (p: Project) => [...p.regions].sort((a, b) => a.start - b.start).map((r) => [r.notes[0]?.pitch, r.start]);

describe('split_region', () => {
  it('cuts notes at the boundary and shortens notes crossing it', () => {
    const p = song();
    p.regions[0].notes = [note(60, 0, 1, 0.8, 'x1'), note(62, 3, 2, 0.8, 'x2'), note(64, 4, 1, 0.8, 'x3'), note(65, 6, 1, 0.8, 'x4')];
    const id = splitRegionAt(p, 'ra', 4)!;
    const left = p.regions.find((r) => r.id === 'ra')!;
    const right = p.regions.find((r) => r.id === id)!;
    expect(left.length).toBe(4);
    expect(left.notes.map((n) => [n.pitch, n.start, n.duration])).toEqual([[60, 0, 1], [62, 3, 1]]);
    expect(right).toMatchObject({ start: 4, length: 12 });
    expect(right.notes.map((n) => [n.pitch, n.start])).toEqual([[64, 0], [65, 2]]);
  });
  it('ignores beats outside the region and keeps audio offsets right', () => {
    const p = song();
    expect(splitRegionAt(p, 'ra', 0)).toBeNull();
    expect(splitRegionAt(p, 'ra', 16)).toBeNull();
    p.regions[0].audio = { sampleId: 's', offset: 1, gain: 1 };
    const id = splitRegionAt(p, 'ra', 8)!;
    expect(p.regions.find((r) => r.id === id)!.audio!.offset).toBe(1 + (8 * 60) / 120);
  });
});

describe('move_section', () => {
  it('moves a section later with ripple: A B C → B A C', () => {
    const p = song();
    moveSection(p, 'A', 32); // start of C on the current timeline = right after B
    expect(order(p)).toEqual([[62, 0], [60, 16], [64, 32]]);
    expect(p.sections!.map((s) => [s.id, s.start]).sort()).toEqual([['A', 16], ['B', 0], ['C', 32]]);
    // automation moves with its section
    expect(p.tracks[0].automation!.volume!.map((pt) => pt.beat).sort((a, b) => a - b)).toEqual([2, 18, 34]);
    expect(p.tracks[0].automation!.volume!.find((pt) => pt.value === 0.1)!.beat).toBe(18);
  });
  it('moves a section earlier with ripple: A B C → C A B', () => {
    const p = song();
    moveSection(p, 'C', 0);
    expect(order(p)).toEqual([[64, 0], [60, 16], [62, 32]]);
  });
  it('without ripple leaves a gap and lands where asked', () => {
    const p = song();
    p.sections = p.sections!.filter((s) => s.id !== 'C');
    p.regions = p.regions.filter((r) => r.id !== 'rc');
    moveSection(p, 'A', 40, false);
    expect(order(p)).toEqual([[62, 16], [60, 40]]);
  });
  it('splits regions that cross the section boundaries', () => {
    const p = song();
    p.regions = [region('long', 't1', 0, 48, [note(60, 0), note(62, 16, 1, 0.8, 'mid'), note(64, 32)])];
    moveSection(p, 'B', 0);
    expect(order(p)).toEqual([[62, 0], [60, 16], [64, 32]]);
  });
  it('rejects a destination inside the section', () => {
    expect(() => moveSection(song(), 'A', 8)).toThrow(/inside the section/);
  });
});

describe('duplicate_section and delete_section', () => {
  it('duplicates right after itself with ripple: A B C → A A B C', () => {
    const p = song();
    const id = duplicateSection(p, 'A');
    expect(order(p)).toEqual([[60, 0], [60, 16], [62, 32], [64, 48]]);
    expect(p.sections!.find((s) => s.id === id)!.start).toBe(16);
    expect(new Set(p.regions.flatMap((r) => r.notes.map((n) => n.id))).size).toBe(4); // fresh note ids
  });
  it('duplicates to the end without ripple (final chorus)', () => {
    const p = song();
    duplicateSection(p, 'B', 48, false);
    expect(order(p)).toEqual([[60, 0], [62, 16], [64, 32], [62, 48]]);
  });
  it('refuses to overlap without ripple', () => {
    expect(() => duplicateSection(song(), 'A', 16, false)).toThrow(/Overlaps/);
  });
  it('deletes a section with or without its content', () => {
    const p = song();
    deleteSection(p, 'B');
    expect(p.regions).toHaveLength(3);
    deleteSection(p, 'C', true);
    expect(order(p)).toEqual([[60, 0], [62, 16]]);
    expect(p.tracks[0].automation!.volume!.map((pt) => pt.beat)).toEqual([2, 18]);
  });
});

describe('energy and proposals', () => {
  it('profiles a span', () => {
    const e = energyProfile(song(), 0, 16);
    expect(e).toMatchObject({ active_tracks: ['t1'], notes_per_bar: 0.25, mean_pitch: 60 });
  });
  it('proposes intro, verses and choruses from repetitions', () => {
    const p = song();
    p.sections = [];
    const bar = (b: number, pitches: number[], vel = 0.8) => pitches.map((pi, i) => note(pi, b * 4 + i, 1, vel));
    const verse = (b: number) => [0, 1, 2, 3].flatMap((k) => bar(b + k, [60, 62]));
    const chorus = (b: number) => [0, 1, 2, 3].flatMap((k) => bar(b + k, [67, 69, 71, 72]));
    const intro = [0, 1, 2, 3].flatMap((k) => bar(k, [48]));
    p.regions = [region('all', 't1', 0, 80, [...intro, ...verse(4), ...chorus(8), ...verse(12), ...chorus(16)])];
    const s = proposeSections(p);
    expect(s.map((x) => [x.kind, x.start / 4 + 1, x.length / 4])).toEqual([
      ['intro', 1, 4],
      ['verse', 5, 4],
      ['chorus', 9, 4],
      ['verse', 13, 4],
      ['chorus', 17, 4],
    ]);
    expect(s.map((x) => x.name)).toEqual(['Intro', 'Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2']);
  });
});
