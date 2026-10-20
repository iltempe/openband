import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { commands } from './commands';

describe('add_drummer / regenerate_drummer (F24)', () => {
  beforeEach(() => {
    commands.new_project({ name: 'Drums', bpm: 100 });
    useStore.setState({ past: [], future: [] });
    commands.add_section({ name: 'Verse', kind: 'verse', start_bar: 1, length_bars: 4 });
    commands.add_section({ name: 'Chorus', kind: 'chorus', start_bar: 5, length_bars: 4 });
  });

  it('plays the whole song, fuller in the chorus, with a fill before it, on a new drum track', () => {
    const r = commands.add_drummer({ style: 'rock', seed: 7, complexity: 0.6 }) as { region_id: string; track_id: string; bars: number; notes: number };
    expect(r.bars).toBe(8);
    const p = useStore.getState().project;
    expect(p.tracks.find((t) => t.id === r.track_id)).toMatchObject({ kind: 'drums', name: 'Drummer' });
    const reg = p.regions.find((x) => x.id === r.region_id)!;
    expect(reg.drummer).toMatchObject({ style: 'rock', seed: 7 });
    const verse = reg.notes.filter((n) => n.start < 16).length;
    const chorus = reg.notes.filter((n) => n.start >= 16).length;
    expect(chorus).toBeGreaterThan(verse);
    expect(reg.notes.some((n) => [45, 48, 50].includes(n.pitch) && n.start >= 12 && n.start < 16)).toBe(true); // fill
    expect(reg.notes.some((n) => n.pitch === 49 && Math.abs(n.start - 16) < 0.02)).toBe(true); // crash
    // The same seed always plays the same part.
    commands.new_project({ name: 'Again', bpm: 100 });
    commands.add_section({ name: 'Verse', kind: 'verse', start_bar: 1, length_bars: 4 });
    commands.add_section({ name: 'Chorus', kind: 'chorus', start_bar: 5, length_bars: 4 });
    const r2 = commands.add_drummer({ style: 'rock', seed: 7, complexity: 0.6 }) as { region_id: string };
    const again = useStore.getState().project.regions.find((x) => x.id === r2.region_id)!;
    expect(again.notes.map((n) => [n.pitch, n.start, n.velocity])).toEqual(reg.notes.map((n) => [n.pitch, n.start, n.velocity]));
  });

  it('one section, then a new take with the next seed (the old one kept)', () => {
    const r = commands.add_drummer({ section_id: 'Chorus', style: 'funk', seed: 1 }) as { region_id: string; bars: number };
    expect(r.bars).toBe(4);
    const before = useStore.getState().project.regions.find((x) => x.id === r.region_id)!;
    expect(before.start).toBe(16);
    const t = commands.regenerate_drummer({ region_id: r.region_id, as_take: true }) as { take_id: string; seed: number };
    expect(t.seed).toBe(2);
    const after = useStore.getState().project.regions.find((x) => x.id === r.region_id)!;
    expect(after.takes).toHaveLength(2);
    expect(after.activeTakeId).toBe(t.take_id);
    expect(after.notes.map((n) => n.start)).not.toEqual(before.notes.map((n) => n.start));
    commands.regenerate_drummer({ region_id: r.region_id, style: 'house', seed: 9 });
    expect(useStore.getState().project.regions.find((x) => x.id === r.region_id)!.drummer).toMatchObject({ style: 'house', seed: 9 });
    expect(() => commands.add_drummer({ style: 'polka' })).toThrow(/Unknown style/);
    const keys = commands.add_track({ kind: 'instrument' }) as unknown as { track_id: string };
    expect(() => commands.add_drummer({ style: 'pop', track_id: keys.track_id })).toThrow(/drum track/);
  });
});
