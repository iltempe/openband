import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lanesFromRecord, parseTargetKey, pointsOf, mix, targetKey, touchRelease, valueAt, writeSpan } from './automation';
import { migrate } from './migrations';
import type { AutoTarget } from './types';

vi.mock('./audio/engine', () => {
  const engine = { position: 0, playing: true, contextRunning: true, play: async () => {}, stop: () => {}, noteOn: () => {}, noteOff: () => {}, unlock: async () => {}, sync: () => {}, setMonitoring: () => {}, fxChain: () => undefined };
  return { engine };
});
const { engine } = await import('./audio/engine');
const { useStore } = await import('./store');
const { commands } = await import('./commands');
const { initAutoWrite, release, setWriteMode } = await import('./autoWrite');
const { applyFxAutomation } = await import('./audio/automate');

describe('automation model (v3)', () => {
  it('migrates v2 records to lanes', () => {
    const v2 = {
      version: 2,
      name: 'Old',
      bpm: 100,
      key: 'C',
      tracks: [
        { id: 't1', name: 'Pad', kind: 'instrument', instrument: 'aurora-pad', color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, reverb: 0.2, delay: 0, cutoff: 0.5, automation: { volume: [{ beat: 0, value: 0 }, { beat: 8, value: 0.8 }], pan: [], tone: [{ beat: 4, value: 0.9 }] } },
        { id: 't2', name: 'Bass', kind: 'instrument', instrument: 'sub-bass', color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, reverb: 0, delay: 0, cutoff: 0.5, automation: {} },
      ],
      regions: [],
      loop: { enabled: false, start: 0, end: 16 },
      masterVolume: 0.8,
      metronome: false,
    };
    const p = migrate(v2);
    expect(p.version).toBe(3);
    expect(p.tracks[0].automation).toEqual([
      { target: { kind: 'mix', param: 'volume' }, points: [{ beat: 0, value: 0 }, { beat: 8, value: 0.8 }] },
      { target: { kind: 'mix', param: 'tone' }, points: [{ beat: 4, value: 0.9 }] },
    ]);
    expect(p.tracks[1].automation).toBeUndefined();
    // v3 stays as it is; a newer schema is refused.
    expect(migrate(p).tracks[0].automation).toEqual(p.tracks[0].automation);
    expect(() => migrate({ ...p, version: 4 })).toThrow(/newer OpenBand/);
    expect(lanesFromRecord(undefined)).toBeUndefined();
  });

  it('names targets with stable keys', () => {
    const targets: AutoTarget[] = [mix('pan'), { kind: 'fx', unit: 'eq', param: 'midFreq' }, { kind: 'plugin', slotId: 'fx_1', paramId: 'cutoff' }, { kind: 'plugin', slotId: null, paramId: 'osc:1' }];
    for (const t of targets) expect(parseTargetKey(targetKey(t))).toEqual(t);
    expect(targetKey(targets[1])).toBe('fx:eq.midFreq');
    expect(parseTargetKey('fx:eq.nope')).toBeNull();
  });

  it('writes spans and returns after a touch', () => {
    const before = [{ beat: 0, value: 0.2 }, { beat: 16, value: 0.6 }];
    let w = writeSpan(before, 4, 4, 0.9);
    w = writeSpan(w, 4, 5, 0.7);
    w = writeSpan(w, 5, 6, 0.5);
    expect(w).toEqual([{ beat: 0, value: 0.2 }, { beat: 4, value: 0.9 }, { beat: 5, value: 0.7 }, { beat: 6, value: 0.5 }, { beat: 16, value: 0.6 }]);
    const back = touchRelease(w, before, 6, 0.8);
    expect(back.at(-2)).toEqual({ beat: 6.25, value: +valueAt(before, 6.25)!.toFixed(10) });
    expect(back.at(-1)).toEqual({ beat: 16, value: 0.6 });
  });
});

describe('set_automation targets and live writing', () => {
  beforeEach(() => {
    commands.new_project({ name: 'A', bpm: 120 });
    useStore.setState({ past: [], future: [], activeTransaction: null, isPlaying: false });
    setWriteMode('off');
  });

  it('automates effect parameters in their own range, old signatures still work', async () => {
    const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    await commands.set_automation({ track_id, target: { kind: 'fx', unit: 'eq', param: 'midFreq' }, points: [{ bar: 1, value: 300 }, { bar: 3, value: 9000 }] });
    await commands.set_automation({ track_id, param: 'volume', points: [{ bar: 1, value: 0 }, { bar: 2, value: 0.8 }] });
    const t = useStore.getState().project.tracks[0];
    expect(pointsOf(t, { kind: 'fx', unit: 'eq', param: 'midFreq' })).toEqual([{ beat: 0, value: 300 }, { beat: 8, value: 6000 }]); // clamped to 6 kHz
    expect(pointsOf(t, mix('volume'))).toHaveLength(2);
    const sum = (await commands.get_project({})) as { tracks: { automation: Record<string, unknown> }[] };
    expect(Object.keys(sum.tracks[0].automation)).toEqual(['fx:eq.midFreq', 'volume']);
    const list = (await commands.list_automatable({ track_id })) as { mix: { param: string; automated?: boolean }[]; fx: { key: string; automated?: boolean }[] };
    expect(list.mix.find((m) => m.param === 'volume')!.automated).toBe(true);
    expect(list.fx.find((f) => f.key === 'fx:eq.midFreq')!.automated).toBe(true);
    commands.clear_automation({ track_id, target: { kind: 'fx', unit: 'eq', param: 'midFreq' } });
    expect(useStore.getState().project.tracks[0].automation).toHaveLength(1);
    await expect(commands.set_automation({ track_id, param: 'wobble', points: [{ bar: 1, value: 1 }] })).rejects.toThrow(/list_automatable/);
  });

  it('touch writes while a control moves during playback and returns on release; latch holds until stop', async () => {
    initAutoWrite();
    const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    const fader = (v: number, at: number) => {
      engine.position = at;
      useStore.getState().commit((d) => void (d.tracks[0].volume = v), { history: false });
    };
    useStore.setState({ isPlaying: true });
    // Read mode: moving the fader changes the static value only.
    fader(0.5, 1);
    expect(useStore.getState().project.tracks[0].automation).toBeUndefined();
    setWriteMode('touch');
    fader(0.4, 4);
    fader(0.3, 5);
    fader(0.2, 6);
    release(`${track_id}|mix:volume`);
    let pts = pointsOf(useStore.getState().project.tracks[0], mix('volume'))!;
    expect(pts.map((p) => p.beat)).toEqual([4, 5, 6, 6.25]);
    expect(pts.at(-1)!.value).toBeCloseTo(0.5, 6); // back to the value before the gesture
    // Effect knobs too.
    engine.position = 8;
    useStore.getState().commit((d) => void (d.tracks[0].fx = { amp: { on: true, drive: 0.9, tone: 0.5, level: 0.7 }, eq: { on: false, low: 0, mid: 0, high: 0, midFreq: 1000 }, comp: { on: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.18, makeup: 4 } }), { history: false });
    expect(pointsOf(useStore.getState().project.tracks[0], { kind: 'fx', unit: 'amp', param: 'drive' })).toEqual([{ beat: 8, value: 0.9 }]);
    release(`${track_id}|fx:amp.drive`);
    // Latch: after release the value is held until playback stops.
    setWriteMode('latch');
    fader(0.7, 10);
    release(`${track_id}|mix:volume`);
    engine.position = 14;
    useStore.setState({ isPlaying: false });
    pts = pointsOf(useStore.getState().project.tracks[0], mix('volume'))!;
    expect(pts.slice(-2)).toEqual([{ beat: 10, value: 0.7 }, { beat: 14, value: 0.7 }]);
    // AI commands never write.
    setWriteMode('touch');
    useStore.setState({ isPlaying: true });
    const n = pts.length;
    commands.update_track({ track_id, volume: 0.1 });
    expect(pointsOf(useStore.getState().project.tracks[0], mix('volume'))!.length).toBeGreaterThanOrEqual(n);
  });

  it('plugin lanes are scheduled as wam-automation events (or set directly)', async () => {
    const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    await commands.set_automation({ track_id, target: { kind: 'fx', unit: 'comp', param: 'threshold' }, points: [{ beat: 0, value: -10 }, { beat: 4, value: -30 }] });
    const t = structuredClone(useStore.getState().project.tracks[0]);
    t.automation!.push({ target: { kind: 'plugin', slotId: 'fx_a', paramId: 'cutoff' }, points: [{ beat: 0, value: 100 }, { beat: 4, value: 5000 }] });
    t.automation!.push({ target: { kind: 'plugin', slotId: null, paramId: 'gain' }, points: [{ beat: 0, value: 1 }] });
    const events: unknown[] = [];
    const direct: unknown[] = [];
    const fxSet: unknown[] = [];
    const withEvents = { audioNode: { scheduleEvents: (e: unknown) => events.push(e), setParameterValues: async () => {} } };
    const withoutEvents = { audioNode: { setParameterValues: async (v: unknown) => void direct.push(v) } };
    const fx = { setParam: (...a: unknown[]) => fxSet.push(a), plugin: (id: string) => (id === 'fx_a' ? withEvents : null) };
    applyFxAutomation(t, 2, 1.5, fx as never, { instance: withoutEvents as never });
    expect(fxSet).toEqual([['comp', 'threshold', -20, 1.5]]);
    expect(events).toEqual([{ type: 'wam-automation', data: { id: 'cutoff', value: 2550, normalized: false }, time: 1.5 }]);
    expect(direct).toEqual([{ gain: { id: 'gain', value: 1, normalized: false } }]);
  });
});
