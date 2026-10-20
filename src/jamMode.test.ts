import { beforeEach, describe, expect, it, vi } from 'vitest';

// The live transport: answers are scheduled on it, never stored.
vi.mock('./audio/engine', () => {
  const engine = { position: 2, playing: true, now: 10, scheduled: [] as unknown[], schedulePhrase(trackId: string, notes: unknown[], at: number) { this.scheduled.push({ trackId, notes, at }); return at + 2; }, stop: () => {}, sync: () => {}, noteOn: () => {}, noteOff: () => {} };
  return { engine };
});
const { useStore } = await import('./store');
const { commands } = await import('./commands');
const { useJam } = await import('./jamMode');

describe('jam answers by phrase_id (F15)', () => {
  beforeEach(() => {
    commands.new_project({ name: 'Jam', bpm: 120 });
    useStore.setState({ past: [], future: [], activeTransaction: null });
    useJam.setState({ last: null, answers: [] });
  });

  it('play_phrase returns a phrase_id; keep_phrase keeps that answer, even an earlier one, once', async () => {
    const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    const a = commands.play_phrase({ track_id, notes: [{ pitch: 60, start: 0, duration: 1 }] }) as { phrase_id: string; start_bar: number };
    const b = commands.play_phrase({ track_id, notes: [{ pitch: 67, start: 0, duration: 1 }] }) as { phrase_id: string };
    expect(a.phrase_id).toMatch(/^phr_/);
    expect(b.phrase_id).not.toBe(a.phrase_id);
    // Heard, not stored: no region, no undo step, nothing for the autosave.
    expect(useStore.getState().project.regions).toHaveLength(0);
    expect(useStore.getState().past).toHaveLength(1); // only add_track
    const kept = commands.keep_phrase({ phrase_id: a.phrase_id }) as { kept: boolean; phrase_id: string; region_id: string };
    expect(kept).toMatchObject({ kept: true, phrase_id: a.phrase_id });
    const r = useStore.getState().project.regions.find((x) => x.id === kept.region_id)!;
    expect(r.notes.map((n) => n.pitch)).toEqual([60]);
    expect(() => commands.keep_phrase({ phrase_id: a.phrase_id })).toThrow(/already kept/);
    // keep_answer still keeps the last one.
    expect(commands.keep_answer({})).toMatchObject({ phrase_id: b.phrase_id });
    expect(useJam.getState().answers).toHaveLength(0);
    useStore.getState().undo();
    expect(useStore.getState().project.regions.flatMap((x) => x.notes.map((n) => n.pitch))).toEqual([60]);
  });

  it('commit:true keeps it right away; only the last 20 answers can be kept', async () => {
    const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    const c = commands.play_phrase({ track_id, notes: [{ pitch: 64, start: 0 }], commit: true }) as { phrase_id: string; kept: boolean };
    expect(c.kept).toBe(true);
    const first = commands.play_phrase({ track_id, notes: [{ pitch: 50, start: 0 }] }) as { phrase_id: string };
    for (let i = 0; i < 20; i++) commands.play_phrase({ track_id, notes: [{ pitch: 52 + (i % 5), start: 0 }] });
    expect(useJam.getState().answers).toHaveLength(20);
    expect(() => commands.keep_phrase({ phrase_id: first.phrase_id })).toThrow(/older than the last 20/);
  });
});
