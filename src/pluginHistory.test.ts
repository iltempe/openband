import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { commands } from './commands';
import { liveWams, type WamInstance } from './audio/wam';
import { pluginSync } from './plugins';
import { crc32, stateHash, trimPluginHistory } from './pluginHistory';
import type { Project } from './types';

/** A plugin whose internal state is not just parameters (a wavetable, a mode, a preset name). */
function fakeWam(initial: Record<string, unknown>) {
  const self = {
    state: structuredClone(initial),
    sets: 0,
    audioNode: {
      getState: async () => structuredClone(self.state),
      setState: async (s: unknown) => {
        self.sets++;
        self.state = structuredClone(s) as Record<string, unknown>;
      },
      getParameterInfo: async () => ({ gain: { id: 'gain', label: 'Gain', minValue: 0, maxValue: 1, defaultValue: 0.5 } }),
      getParameterValues: async () => ({ gain: { id: 'gain', value: self.state.gain as number, normalized: false } }),
      setParameterValues: async (v: Record<string, { value: number }>) => void (self.state = { ...self.state, gain: v.gain.value }),
    },
  };
  return self;
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const ORIGINAL = { mode: 'warm', wavetable: [0.1, 0.5, -0.3, 0.9], preset: 'Init', gain: 0.5 };

async function setup() {
  commands.new_project({ name: 'P', bpm: 100 });
  const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
  const slot = { id: 'slot1', url: 'https://example.com/fake.js', name: 'Fake Synth FX', on: true, state: structuredClone(ORIGINAL) };
  useStore.getState().commit((d) => {
    const t = d.tracks.find((x) => x.id === track_id)!;
    t.fx = { ...(t.fx ?? {}), plugins: [slot] } as never;
  });
  const wam = fakeWam(ORIGINAL);
  liveWams.clear();
  liveWams.set(`${track_id}:slot1`, wam as unknown as WamInstance);
  useStore.setState({ past: [], future: [], activeTransaction: null, pluginWindow: null });
  await pluginSync.projectChanged(); // first sight: baseline, nothing applied
  return { track_id, wam };
}

describe('undo of plugin state (F19)', () => {
  beforeEach(() => {
    pluginSync.quietMs = 30;
  });

  it('a GUI edit is one undo step; undo restores the exact state, redo the edited one', async () => {
    const { track_id, wam } = await setup();
    // Opening (and re-opening) the window is not an edit.
    useStore.setState({ pluginWindow: { trackId: track_id, slotId: 'slot1' } });
    expect(await pluginSync.poll()).toBe(false);
    useStore.setState({ pluginWindow: null });
    expect(await pluginSync.poll()).toBe(false);
    useStore.setState({ pluginWindow: { trackId: track_id, slotId: 'slot1' } });
    expect(await pluginSync.poll()).toBe(false);
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().activeTransaction).toBeNull();

    // The user turns the GUI's knobs and draws a new wavetable: several polls, one step.
    wam.state = { ...wam.state, mode: 'bright', wavetable: [1, 0, 1, 0] };
    expect(await pluginSync.poll()).toBe(true);
    wam.state = { ...wam.state, preset: 'My sound' };
    expect(await pluginSync.poll()).toBe(true);
    expect(await pluginSync.poll()).toBe(false);
    await tick(60);
    const s = useStore.getState();
    expect(s.activeTransaction).toBeNull();
    expect(s.past).toHaveLength(1);
    expect(s.past[0].label).toBe('Edit Fake Synth FX');
    const edited = structuredClone(wam.state);

    useStore.getState().undo();
    await tick();
    expect(wam.state).toEqual(ORIGINAL);
    // Applying the old state is not a new edit.
    expect(await pluginSync.poll()).toBe(false);
    expect(useStore.getState().past).toHaveLength(0);

    useStore.getState().redo();
    await tick();
    expect(wam.state).toEqual(edited);
    expect(await pluginSync.poll()).toBe(false);

    // get_history says which plugins a step changed.
    const h = commands.get_history({}) as { past: { label: string; plugins_changed: string[] }[] };
    expect(h.past[0]).toMatchObject({ label: 'Edit Fake Synth FX', plugins_changed: ['Fake Synth FX'] });
  });

  it('set_plugin_params from the AI is undoable', async () => {
    const { track_id, wam } = await setup();
    await commands.set_plugin_params({ track_id, slot_id: 'slot1', values: { gain: 0.9 } });
    expect(wam.state.gain).toBe(0.9);
    expect(useStore.getState().past).toHaveLength(1);
    useStore.getState().undo();
    await tick();
    expect(wam.state).toEqual(ORIGINAL);
    const sets = wam.sets;
    // An unrelated edit does not touch the plugin.
    commands.set_tempo({ bpm: 120 });
    await tick();
    expect(wam.sets).toBe(sets);
  });

  it('keeps at most the limit of plugin state in history; older steps say so and leave plugins alone', async () => {
    const { wam } = await setup();
    const steps = (n: number) => {
      for (let i = 0; i < n; i++) {
        useStore.getState().commit((d) => {
          d.tracks[0].fx!.plugins![0].state = { ...ORIGINAL, preset: `p${i}`, blob: 'x'.repeat(1000) };
        });
      }
    };
    steps(5);
    const past = useStore.getState().past;
    const trimmed = trimPluginHistory(past, 2500)!;
    expect(trimmed.filter((e) => e.pluginStateDropped)).toHaveLength(past.length - 2);
    expect(trimmed.slice(-2).every((e) => !e.pluginStateDropped)).toBe(true);
    useStore.setState({ past: trimmed });
    await tick();
    const sets = wam.sets;
    useStore.getState().undo(5);
    await tick();
    // The oldest steps had their states dropped: the plugin keeps whatever it has, it is not reset to nothing.
    expect(wam.state).toBeDefined();
    expect(wam.sets).toBeGreaterThanOrEqual(sets);
    const h = commands.get_history({ limit: 200 }) as { future: { plugin_state_dropped?: boolean }[] };
    expect(h.future.some((e) => e.plugin_state_dropped)).toBe(true);
  });

  it('hashes states stably', () => {
    expect(stateHash({ a: 1, b: [1, 2] })).toBe(stateHash({ b: [1, 2], a: 1 }));
    expect(stateHash({ a: 1 })).not.toBe(stateHash({ a: 2 }));
    expect(stateHash(new Float32Array([1, 2]))).toBe(stateHash([1, 2]));
    expect(stateHash(undefined)).toBeUndefined();
    expect(crc32('123456789')).toBe(0xcbf43926);
    const p: Project = useStore.getState().project;
    expect(typeof p.name).toBe('string');
  });
});
