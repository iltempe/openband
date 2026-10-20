import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store';
import { commands } from '../commands';
import { chordPitchClasses, progression, romanToChord } from './plan';
import { PROGRESSIONS, harmonize, surprisePlan } from './surprise';
import { applyPlan } from './apply';
import { TEMPLATES } from '../templates';

describe('harmony helpers', () => {
  it('turns Roman numerals into chords in major and minor keys', () => {
    expect(progression(['I', 'V', 'vi', 'IV'], 'C')).toEqual(['C', 'G', 'Am', 'F']);
    expect(progression(['ii7', 'V7', 'Imaj7'], 'Bb')).toEqual(['Cm7', 'F7', 'Bbmaj7']);
    expect(progression(['i', 'bVII', 'bVI', 'V'], 'Am')).toEqual(['Am', 'G', 'F', 'E']);
    expect(romanToChord('bVII', 'E')).toBe('D');
    expect(chordPitchClasses('Am')).toEqual([9, 0, 4]);
    // Every built-in progression is valid in some key.
    for (const p of PROGRESSIONS) expect(progression(p.numerals, p.minor ? 'Dm' : 'G').length).toBe(4);
  });
});

describe('surprise me', () => {
  it('is deterministic for a seed and makes an 8-bar loop', () => {
    const a = surprisePlan(42);
    expect(surprisePlan(42)).toEqual(a);
    expect(a.plan.loop).toEqual([1, 9]);
    expect(a.plan.tracks.map((t) => t.name)).toEqual(['Drums', 'Bass', 'Keys']);
    expect(a.summary.chords).toHaveLength(4);
    const seeds = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(surprisePlan(i).summary)));
    expect(seeds.size).toBeGreaterThan(10); // varied
  });
});

describe('harmonize a hummed melody', () => {
  it('picks the triad each bar spends its time on', () => {
    // C major: bar 1 on C-E-G, bar 2 on F-A, bar 3 on G-B-D, bar 4 on A-C-E.
    const melody = [
      { pitch: 60, start: 0, duration: 2 }, { pitch: 64, start: 2, duration: 1 }, { pitch: 67, start: 3, duration: 1 },
      { pitch: 65, start: 4, duration: 2 }, { pitch: 69, start: 6, duration: 2 },
      { pitch: 67, start: 8, duration: 1 }, { pitch: 71, start: 9, duration: 2 }, { pitch: 74, start: 11, duration: 1 },
      { pitch: 69, start: 12, duration: 2 }, { pitch: 76, start: 14, duration: 1 }, { pitch: 72, start: 15, duration: 1 },
    ];
    expect(harmonize(melody, 'C', 4)).toEqual(['C', 'F', 'G', 'Am']);
    // A silent bar keeps the previous chord.
    expect(harmonize(melody.slice(0, 3), 'C', 2)).toEqual(['C', 'C']);
  });
});

describe('templates', () => {
  beforeEach(() => {
    commands.new_project({ name: 'T' });
    useStore.setState({ past: [], future: [], activeTransaction: null });
  });

  it.each(TEMPLATES.map((t) => [t.id, t]))('%s builds with sections and explanations, as one undo step', async (_id, t) => {
    await applyPlan(t.plan);
    const p = useStore.getState().project;
    expect(p.name).toBe(t.plan.name);
    expect(p.bpm).toBe(t.plan.bpm);
    expect(p.tracks).toHaveLength(t.plan.tracks.length);
    expect(p.regions.length).toBeGreaterThanOrEqual(t.plan.tracks.length);
    expect(p.regions.every((r) => r.notes.length > 0)).toBe(true);
    expect(p.sections?.length).toBe(t.plan.sections?.length);
    expect(p.annotations?.length).toBe(t.plan.notes?.length);
    if (t.plan.lyrics) expect(p.lyrics?.lines.length).toBeGreaterThan(0);
    expect(p.loop).toMatchObject({ enabled: true });
    expect(useStore.getState().past).toHaveLength(1);
  });
});
