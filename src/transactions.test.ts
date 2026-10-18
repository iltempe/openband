import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './store';
import { commands, runCommand, transactionConfig } from './commands';

const st = () => useStore.getState();
const reset = () => {
  commands.new_project({ name: 'T', bpm: 100 });
  useStore.setState({ past: [], future: [], activeTransaction: null, bridgeLog: [] });
};

describe('transactions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reset();
  });
  afterEach(() => vi.useRealTimers());

  it('groups consecutive AI commands into one undo step', async () => {
    const before = JSON.stringify(st().project);
    const { track_id } = (await runCommand('add_track', { kind: 'instrument' })) as { track_id: string };
    for (let i = 0; i < 9; i++) await runCommand('add_region', { track_id, start_bar: i + 1, notes: [{ pitch: 60 + i, start: 0 }] });
    expect(st().activeTransaction?.commands).toBe(10);
    vi.advanceTimersByTime(transactionConfig.autoCloseMs + 10);
    expect(st().activeTransaction).toBeNull();
    expect(st().past).toHaveLength(1);
    expect(st().past[0]).toMatchObject({ source: 'ai', commands: 10 });
    st().undo();
    expect(JSON.stringify(st().project)).toBe(before);
    st().redo();
    expect(st().project.regions).toHaveLength(9);
  });

  it('read-only AI commands do not open a step', async () => {
    await runCommand('get_project', {});
    expect(st().activeTransaction).toBeNull();
  });

  it('supports explicit begin_change / end_change with a label', async () => {
    await runCommand('begin_change', { label: 'Lo-fi beat' });
    await runCommand('set_tempo', { bpm: 82 });
    await runCommand('add_track', { kind: 'drums' });
    const res = (await runCommand('end_change', {})) as { label: string; commands: number };
    expect(res).toMatchObject({ label: 'Lo-fi beat', commands: 2 });
    expect(st().past).toHaveLength(1);
    expect(st().past[0].label).toBe('Lo-fi beat');
    const hist = commands.get_history({}) as { past: { label: string }[] };
    expect(hist.past[0].label).toBe('Lo-fi beat');
  });

  it('an empty transaction creates no entry', async () => {
    await runCommand('begin_change', { label: 'Nothing' });
    await runCommand('end_change', {});
    expect(st().past).toHaveLength(0);
  });

  it('begin_change closes an automatic step that is still open', async () => {
    await runCommand('set_tempo', { bpm: 90 });
    await runCommand('begin_change', { label: 'Second' });
    await runCommand('set_tempo', { bpm: 95 });
    await runCommand('end_change', {});
    expect(st().past.map((e) => e.label)).toEqual([expect.any(String), 'Second']);
  });

  it('a UI drag produces a single entry', () => {
    st().checkpoint('Move region');
    for (let i = 0; i < 20; i++) st().commit((d) => void (d.bpm = 100 + i), { history: false });
    st().endTransaction();
    expect(st().past).toHaveLength(1);
    expect(st().past[0]).toMatchObject({ label: 'Move region', source: 'ui' });
  });

  it('a user edit closes the open AI step instead of merging into it', async () => {
    await runCommand('set_tempo', { bpm: 70 });
    st().commit((d) => void (d.key = 'Dm'));
    expect(st().past.map((e) => e.source)).toEqual(['ai', 'ui']);
  });

  it('nested transactions count only the outermost', () => {
    const a = st().beginTransaction('outer', 'ui');
    const b = st().beginTransaction('inner', 'ui');
    expect(b).toBe(a);
    st().commit((d) => void (d.bpm = 123));
    st().endTransaction(b);
    expect(st().activeTransaction).not.toBeNull();
    st().endTransaction(a);
    expect(st().past).toHaveLength(1);
    expect(st().past[0].label).toBe('outer');
  });

  it('undo with steps', async () => {
    st().commit((d) => void (d.bpm = 101));
    st().commit((d) => void (d.bpm = 102));
    st().commit((d) => void (d.bpm = 103));
    await runCommand('undo', { steps: 2 });
    expect(st().project.bpm).toBe(101);
  });
});
