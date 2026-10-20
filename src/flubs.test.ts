import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Flub, Region, Take } from './types';
import { bestTakeAt, fixWindow, flubLoop, pedalCC, stepFlub } from './flubs';

// The recorder drives the transport: here a fake one whose playhead the test moves.
vi.mock('./audio/engine', () => {
  const engine = { position: 0, playing: true, contextRunning: true, play: async () => {}, stop: () => {}, noteOn: () => {}, noteOff: () => {}, unlock: async () => {} };
  return { engine };
});
const { engine } = await import('./audio/engine');
const { useStore } = await import('./store');
const { commands } = await import('./commands');
const { liveNoteOff, liveNoteOn, startRecording, stopRecording } = await import('./input');
const { onControlChange, usePedal, useFlubLive } = await import('./flubLive');

const take = (id: string, createdAt = 0): Take => ({ id, name: id, notes: [], createdAt, author: 'user' });
const flub = (takeId: string, beat: number, kind: Flub['kind'] = 'flub'): Flub => ({ id: `${takeId}-${beat}-${kind}`, beat, kind, regionId: 'r', takeId, createdAt: 0 });
const region = (takes: Take[]): Region => ({ id: 'r', trackId: 't', name: 'Bass', start: 16, length: 16, notes: [], takes, activeTakeId: takes[0]?.id });

describe('flub markers: picking the best take', () => {
  it('skips takes with a mistake within ±1 beat, then prefers the most good marks', () => {
    const r = region([take('A', 1), take('B', 2), take('C', 3), take('D', 4)]);
    const marks = [
      flub('A', 21), // the mistake being fixed (beat 21 = bar 6, beat 2)
      flub('B', 21.8), // B also slips there
      flub('C', 26),
      flub('C', 17, 'good'), // C: clean here, one good mark
      flub('D', 30, 'good'),
      flub('D', 18, 'good'), // D: clean here, two good marks
    ];
    expect(bestTakeAt(r, marks, 21)?.id).toBe('D');
    // Without D's marks, C wins (B has a mistake within 1 beat, A is the one with the flub).
    expect(bestTakeAt(r, marks.slice(0, 4), 21)?.id).toBe('C');
    // Ties: fewer mistakes overall, then the newest take.
    expect(bestTakeAt(region([take('A', 1), take('B', 2), take('C', 3)]), [flub('A', 21), flub('B', 30)], 21)?.id).toBe('C');
    // A mistake exactly 1 beat away still counts; 1.25 away does not.
    expect(bestTakeAt(region([take('A'), take('B')]), [flub('A', 21), flub('B', 22)], 21)).toBeNull();
    expect(bestTakeAt(region([take('A'), take('B')]), [flub('A', 21), flub('B', 22.25)], 21)?.id).toBe('B');
    // Marks without a take id belong to the first take (recorded before takes existed).
    expect(bestTakeAt(region([take('A'), take('B')]), [{ ...flub('A', 21), takeId: undefined }], 21)?.id).toBe('B');
    expect(bestTakeAt(region([take('A')]), [], 21)).toBeNull();
  });

  it('replaces the bars around the mistake, and loops 2 bars around it', () => {
    const r = region([]);
    expect(fixWindow(r, 21)).toEqual({ from: 4, to: 8 });
    expect(fixWindow(r, 19.9)).toEqual({ from: 0, to: 8 }); // near a bar line: both bars
    expect(fixWindow(r, 16)).toEqual({ from: 0, to: 4 });
    expect(flubLoop(21)).toEqual({ start: 16, end: 24 }); // early in bar 6: bar 5–6
    expect(flubLoop(23)).toEqual({ start: 20, end: 28 }); // late in bar 6: bar 6–7
    expect(flubLoop(0.5)).toEqual({ start: 0, end: 8 });
    const marks = [flub('A', 4), flub('A', 12), flub('A', 8, 'good'), { ...flub('A', 20), resolved: true }];
    expect(stepFlub(marks, 5, 1)?.beat).toBe(12);
    expect(stepFlub(marks, 12, 1)?.beat).toBe(4); // wraps
    expect(stepFlub(marks, 12, -1)?.beat).toBe(4);
    expect(stepFlub([], 0, 1)).toBeNull();
  });
});

describe('flub pedal', () => {
  it('learns a controller and marks only on the way down, only while recording', () => {
    let s = { cc: 64, learning: true };
    const learned = pedalCC(s, 67, 127, false);
    expect(learned.action).toBe('learned');
    s = learned.state;
    expect(s).toMatchObject({ cc: 67, learning: false });
    let r = pedalCC({ ...s, down: false }, 67, 127, true);
    expect(r.action).toBe('flub');
    r = pedalCC(r.state, 67, 120, true); // still held
    expect(r.action).toBeNull();
    r = pedalCC(r.state, 67, 0, true);
    r = pedalCC(r.state, 67, 127, true);
    expect(r.action).toBe('flub');
    expect(pedalCC({ cc: 67, learning: false }, 64, 127, true).action).toBeNull(); // another controller
    expect(pedalCC({ cc: 67, learning: false }, 67, 127, false).action).toBeNull(); // not recording
  });
});

describe('flub markers in the studio', () => {
  beforeEach(() => {
    commands.new_project({ name: 'T', bpm: 120 });
    useStore.setState({ past: [], future: [], activeTransaction: null });
    engine.position = 0;
  });

  it('marks during a cycle recording go to the take of their pass, and follow the region when it moves', async () => {
    const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    useStore.setState({ selectedTrackId: track_id });
    commands.set_loop({ enabled: true, start_bar: 3, end_bar: 5 }); // beats 8–16
    engine.position = 8;
    const steps = useStore.getState().past.length;
    await startRecording();
    const play = (pitch: number, at: number) => {
      engine.position = at;
      liveNoteOn(pitch, 0.8);
      engine.position = at + 0.5;
      liveNoteOff(pitch);
    };
    // Pass 0: a mistake at beat 10.
    play(60, 8);
    engine.position = 10;
    onControlChange(64, 127); // the default pedal (CC64)
    onControlChange(64, 0);
    play(62, 12);
    expect(useFlubLive.getState().pending).toHaveLength(1);
    expect(useStore.getState().project.flubs ?? []).toHaveLength(0); // not stored until the take is
    // The transport jumps back (the recorder watches the playhead every 20 ms): pass 1, a good part at beat 11.
    const tick = () => new Promise((r) => setTimeout(r, 50));
    await tick();
    engine.position = 8;
    await tick();
    play(64, 9);
    engine.position = 11;
    commands.add_flub({ kind: 'good' });
    stopRecording();

    const p = useStore.getState().project;
    const rgn = p.regions.find((r) => r.trackId === track_id)!;
    expect(rgn.takes).toHaveLength(2);
    const [bad, good] = [...p.flubs!].sort((a, b) => a.beat - b.beat);
    expect(bad).toMatchObject({ kind: 'flub', beat: 10, regionId: rgn.id, takeId: rgn.takes![0].id, trackId: track_id });
    expect(good).toMatchObject({ kind: 'good', beat: 11, regionId: rgn.id, takeId: rgn.takes![1].id });
    // One undo step for the recording and its marks.
    expect(useStore.getState().past.length - steps).toBe(1);

    // The region moves 4 bars later: the marks go with it.
    commands.update_region({ region_id: rgn.id, start_bar: 7 });
    expect(useStore.getState().project.flubs!.map((f) => f.beat).sort()).toEqual([26, 27]);
    // To another track: the marks follow it too.
    const other = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    commands.update_region({ region_id: rgn.id, track_id: other.track_id });
    expect(useStore.getState().project.flubs!.every((f) => f.trackId === other.track_id)).toBe(true);

    // Take 2 (the last pass) is active, so the mistake isn't heard: nothing to comp.
    expect(commands.replace_with_best_take({ flub_id: bad.id })).toMatchObject({ already_active: true });
    useStore.getState().undo();
    // Back on take 1: take 2 has no mistake there and a good mark.
    commands.set_active_take({ region_id: rgn.id, take_id: rgn.takes![0].id });
    const res = commands.replace_with_best_take({ flub_id: bad.id }) as { from_take: string; from_beat: number; to_beat: number };
    expect(res).toMatchObject({ from_take: rgn.takes![1].name, from_beat: 0, to_beat: 4 });
    const after = useStore.getState().project;
    expect(after.flubs!.find((f) => f.id === bad.id)!.resolved).toBe(true);
    const comp = after.regions.find((r) => r.id === rgn.id)!;
    expect(comp.takes).toHaveLength(3);
    // Bar 1 of the region from take 2 (its note at beat 1), bar 2 from take 1 (its note at beat 4).
    expect(comp.notes.map((n) => [n.pitch, n.start])).toEqual([
      [64, 1],
      [62, 4],
    ]);
    // Undo brings the mistake back as open.
    useStore.getState().undo();
    expect(useStore.getState().project.flubs!.find((f) => f.id === bad.id)!.resolved).toBeFalsy();

    // Deleting the region keeps the marks, without the link.
    commands.delete_region({ region_id: rgn.id });
    expect(useStore.getState().project.flubs!.every((f) => !f.regionId && !f.takeId)).toBe(true);
  });

  it('add_flub / list_flubs / resolve_flub / delete_flub', async () => {
    const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    commands.add_region({ track_id, start_bar: 2, length_bars: 2, notes: [{ pitch: 60, start: 0 }] });
    const a = commands.add_flub({ bar: 2.5, track_id, text: 'late snare' }) as { flub_id: string; beat: number; pending: boolean };
    expect(a).toMatchObject({ beat: 6, pending: false });
    commands.add_flub({ beat: 0, kind: 'note' });
    let list = (commands.list_flubs({}) as { flubs: { id: string; bar: number; region_id?: string; text?: string; kind: string }[] }).flubs;
    expect(list.map((f) => f.kind)).toEqual(['note', 'flub']);
    expect(list[1]).toMatchObject({ bar: 2.5, text: 'late snare', region_id: expect.any(String) });
    commands.resolve_flub({ flub_id: a.flub_id });
    list = (commands.list_flubs({ unresolved_only: true }) as { flubs: { id: string }[] }).flubs as never;
    expect(list.map((f) => f.id)).not.toContain(a.flub_id);
    expect(() => commands.replace_with_best_take({ flub_id: a.flub_id })).toThrow(/several takes/);
    commands.delete_flub({ flub_id: a.flub_id });
    expect(useStore.getState().project.flubs!.some((f) => f.id === a.flub_id)).toBe(false);
    expect(() => commands.delete_flub({ flub_id: 'nope' })).toThrow(/list_flubs/);
  });

  it('a pedal learned in the settings marks while recording', async () => {
    usePedal.setState({ cc: 64, learning: true });
    onControlChange(11, 90);
    expect(usePedal.getState()).toMatchObject({ cc: 11, learning: false });
    const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    useStore.setState({ selectedTrackId: track_id });
    onControlChange(11, 0);
    onControlChange(11, 127); // not recording: nothing
    expect(useFlubLive.getState().pending).toHaveLength(0);
    onControlChange(11, 0); // released
    await startRecording();
    engine.position = 3;
    onControlChange(11, 127);
    expect(useFlubLive.getState().pending.map((p) => p.flub.beat)).toEqual([3]);
    stopRecording(); // no notes: the mark is kept anyway
    expect(useStore.getState().project.flubs).toMatchObject([{ beat: 3, kind: 'flub', trackId: track_id }]);
    usePedal.setState({ cc: 64, learning: false });
  });
});
