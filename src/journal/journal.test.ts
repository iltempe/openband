import { beforeEach, describe, expect, it } from 'vitest';
import { apply, deepEqual, diff } from './patch';
import { MemoryJournalStore, SongJournal } from './timeline';
import { useStore } from '../store';
import { commands } from '../commands';
import { canonicalJSON } from '../versions/canonical';
import { applyRecovery, initJournal, nextExportName, setJournalStore, useJournal } from '.';
import type { Project } from '../types';

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

describe('journal patches', () => {
  it('apply(a, diff(a, b)) equals b, with id-keyed arrays diffed by id', () => {
    const a = { name: 'x', tracks: [{ id: 't1', v: 1, fx: { on: true } }, { id: 't2', v: 2 }], list: [1, 2, 3], gone: 5, nested: { deep: { k: [{ id: 'n1', p: 60 }] } } };
    const b = { name: 'y', tracks: [{ id: 't3', v: 9 }, { id: 't1', v: 1, fx: { on: false } }], list: [1, 2], nested: { deep: { k: [{ id: 'n1', p: 62 }, { id: 'n2', p: 64 }] } }, added: { z: null } };
    const ops = diff(a, b);
    expect(deepEqual(apply(a, ops), b)).toBe(true);
    // Moving one note stores one small op, not the whole array.
    const ops2 = diff(b, { ...b, nested: { deep: { k: [{ id: 'n1', p: 62 }, { id: 'n2', p: 65 }] } } });
    expect(JSON.stringify(ops2).length).toBeLessThan(120);
    expect(diff(a, structuredClone(a))).toEqual([]);
    // apply never touches its input
    const before = JSON.stringify(a);
    apply(a, ops);
    expect(JSON.stringify(a)).toBe(before);
  });
});

/** A random command against the real command API (what the user or the AI does all day). */
async function randomCommand() {
  const p = useStore.getState().project;
  const tracks = p.tracks;
  const regions = p.regions;
  const r = rnd();
  try {
    if (r < 0.12 || !tracks.length) return void (await commands.add_track({ kind: pick(['instrument', 'drums', 'instrument']) }));
    if (r < 0.3 || !regions.length) {
      const t = pick(tracks);
      return void commands.add_region({ track_id: t.id, start_bar: 1 + Math.floor(rnd() * 16), length_bars: 1 + Math.floor(rnd() * 4), notes: Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({ pitch: t.kind === 'drums' ? pick(['kick', 'snare', 'hihat']) : 48 + Math.floor(rnd() * 24), start: Math.floor(rnd() * 8) / 2, duration: 0.5 })) });
    }
    if (r < 0.42) return void commands.add_notes({ region_id: pick(regions).id, notes: [{ pitch: 60 + Math.floor(rnd() * 12), start: Math.floor(rnd() * 4) }] });
    if (r < 0.5) return void commands.update_region({ region_id: pick(regions).id, start_bar: 1 + Math.floor(rnd() * 20) });
    if (r < 0.56) return void commands.transpose_region({ region_id: pick(regions).id, semitones: pick([-2, -1, 1, 2, 12]) });
    if (r < 0.63) return void commands.update_track({ track_id: pick(tracks).id, volume: rnd(), pan: rnd() * 2 - 1, mute: rnd() < 0.2 });
    if (r < 0.67) return void commands.set_tempo({ bpm: 70 + Math.floor(rnd() * 90) });
    if (r < 0.71) return void commands.delete_region({ region_id: pick(regions).id });
    if (r < 0.73 && tracks.length > 1) return void commands.delete_track({ track_id: pick(tracks).id });
    if (r < 0.77) return void commands.set_automation({ track_id: pick(tracks).id, param: 'volume', points: [{ bar: 1, value: rnd() }, { bar: 3, value: rnd() }] });
    if (r < 0.8) return void commands.add_section({ name: `S${Math.floor(rnd() * 100)}`, kind: 'verse', start_bar: 1 + Math.floor(rnd() * 8) * 4, length_bars: 4 });
    if (r < 0.88) return void useStore.getState().undo();
    if (r < 0.94) return void useStore.getState().redo();
    return void commands.rename_project({ name: `Song ${Math.floor(rnd() * 1000)}` });
  } catch {
    // an invalid random command (overlapping section…) changes nothing
  }
}

describe('time machine reconstruction', () => {
  it('500 random commands: the song rebuilt at every instant equals the recorded one', async () => {
    commands.new_project({ name: 'Random', bpm: 100 });
    useStore.setState({ past: [], future: [], activeTransaction: null });
    const store = new MemoryJournalStore();
    const j = await new SongJournal('song_r', store, { checkpointEvery: 50, checkpointMs: 1e12, maxAgeMs: 1e15, maxBytes: 1e12 }).load();
    const truth: { at: number; json: string }[] = [];
    for (let i = 0; i < 500; i++) {
      await randomCommand();
      const at = 1_000_000 + i * 1000;
      const p = useStore.getState().project;
      await j.record(p, `step ${i}`, 'ui', at);
      truth.push({ at, json: canonicalJSON(p, { includeMeta: true }) });
    }
    expect(j.entries.filter((e) => e.kind === 'checkpoint').length).toBeGreaterThanOrEqual(2);
    for (const { at, json } of truth) expect(canonicalJSON(j.stateAt(at)!.project, { includeMeta: true })).toBe(json);
    // Between two steps: the earlier one. Before the start: nothing.
    expect(canonicalJSON(j.stateAt(truth[100].at + 500)!.project, { includeMeta: true })).toBe(truth[100].json);
    expect(j.stateAt(0)).toBeNull();
    // Reloaded from storage, the same.
    const again = await new SongJournal('song_r', store).load();
    for (const k of [0, 49, 50, 51, 250, 499]) expect(canonicalJSON(again.stateAt(truth[k].at)!.project, { includeMeta: true })).toBe(truth[k].json);
    // Compaction keeps everything after the cut rebuildable.
    const compacted = await new SongJournal('song_r', store, { checkpointEvery: 50, checkpointMs: 1e12, maxAgeMs: 1e12 - 1_000_000 - 300_000, maxBytes: 1e12 }).load();
    const dropped = await compacted.compact(1e12);
    expect(dropped).toBeGreaterThan(250);
    expect(compacted.stateAt(truth[200].at)).toBeNull();
    for (const k of [301, 350, 499]) expect(canonicalJSON(compacted.stateAt(truth[k].at)!.project, { includeMeta: true })).toBe(truth[k].json);
  }, 60000);
});

describe('crash recovery', () => {
  beforeEach(() => useJournal.setState({ recovery: null }));

  it('the journal is ahead of the autosave: the banner offers the exact state back', async () => {
    commands.new_project({ name: 'Crash', bpm: 90 });
    const { track_id } = (await commands.add_track({ kind: 'instrument' })) as { track_id: string };
    const autosaved = structuredClone(useStore.getState().project) as Project;
    const pid = autosaved.meta!.projectId;
    const t0 = Date.now() - 60_000;
    // The tab journaled 14 more changes, then crashed before the autosave caught up.
    const store = new MemoryJournalStore();
    const j = await new SongJournal(pid, store).load();
    await j.record(autosaved, 'start', 'system', t0 - 1000);
    for (let i = 0; i < 14; i++) {
      commands.add_region({ track_id, start_bar: 1 + i, length_bars: 1, notes: [{ pitch: 60 + i, start: 0 }] });
      await j.record(useStore.getState().project, `edit ${i}`, 'ui', t0 + (i + 1) * 1000);
    }
    const lost = canonicalJSON(useStore.getState().project);
    // Restart: the autosaved (older) song is what loads.
    useStore.setState({ project: { ...autosaved, meta: { ...autosaved.meta!, updatedAt: t0 } }, past: [], future: [] });
    setJournalStore(store);
    await initJournal();
    const r = useJournal.getState().recovery;
    expect(r?.count).toBe(14);
    applyRecovery();
    expect(canonicalJSON(useStore.getState().project)).toBe(lost);
    // One undo step: undo goes back to the autosaved state.
    useStore.getState().undo();
    expect(useStore.getState().project.regions).toHaveLength(0);
  });

  it('no banner when the autosave is current', async () => {
    commands.new_project({ name: 'Fine', bpm: 90 });
    const p = useStore.getState().project;
    const store = new MemoryJournalStore();
    const j = await new SongJournal(p.meta!.projectId, store).load();
    await j.record(p, 'start', 'system', Date.now() - 5000);
    useStore.setState({ project: { ...p, meta: { ...p.meta!, updatedAt: Date.now() } } });
    setJournalStore(store);
    await initJournal();
    expect(useJournal.getState().recovery).toBeNull();
  });
});

describe('exports never overwrite', () => {
  it('adds a version suffix to a name exported again', () => {
    let c: Record<string, number> = {};
    const names = [1, 2, 3].map(() => {
      const r = nextExportName(c, 'song', '.openband');
      c = r.counts;
      return r.name;
    });
    expect(names).toEqual(['song.openband', 'song v2.openband', 'song v3.openband']);
    expect(nextExportName(c, 'Other', '.openband').name).toBe('Other.openband');
  });
});
