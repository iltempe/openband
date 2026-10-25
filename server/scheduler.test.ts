// The GPU scheduler (SPEC v0.6 §6, E4): one heavy model at a time per device, interactive before batch,
// least recently used unloaded to fit the VRAM budget.
import { describe, expect, it } from 'vitest';
import { GpuScheduler, gpuNeed } from './scheduler.mjs';

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe('GPU scheduler', () => {
  it('one heavy model at a time per device; interactive requests before batch jobs', async () => {
    const s = new GpuScheduler();
    const order: string[] = [];
    const first = gate();
    const a = s.run({ id: 'a', vram: 4, priority: 'batch' }, async () => (order.push('a'), await first.p, 'a'));
    const b = s.run({ id: 'b', vram: 4, priority: 'batch' }, async () => (order.push('b'), 'b'));
    const c = s.run({ id: 'c', vram: 4, priority: 'interactive' }, async () => (order.push('c'), 'c'));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['a']);
    expect(s.stateOf('b')).toMatchObject({ queued: 1, running: false });
    expect(s.stateOf('a')).toMatchObject({ running: true, loaded: true });
    first.open();
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a', 'c', 'b']);
    // Another device runs alongside.
    const g = gate();
    const x = s.run({ id: 'x', device: 'cuda:0', vram: 1 }, async () => (await g.p, 'x'));
    expect(await s.run({ id: 'y', device: 'cuda:1', vram: 1 }, async () => 'y')).toBe('y');
    g.open();
    await x;
  });

  it('the least recently used engine is unloaded to fit the VRAM budget', async () => {
    const unloaded: string[] = [];
    let t = 0;
    const s = new GpuScheduler({ budgetGb: 10, unload: async (id) => void unloaded.push(id), now: () => ++t });
    await s.run({ id: 'a', vram: 6 }, async () => 0);
    await s.run({ id: 'b', vram: 6 }, async () => 0); // 6 + 6 > 10: a goes
    expect(unloaded).toEqual(['a']);
    await s.run({ id: 'c', vram: 2 }, async () => 0); // 6 + 2 fits
    expect(unloaded).toEqual(['a']);
    await s.run({ id: 'a', vram: 6 }, async () => 0); // b (least recently used) goes, c stays
    expect(unloaded).toEqual(['a', 'b']);
    expect(['a', 'b', 'c'].map((id) => s.stateOf(id).loaded)).toEqual([true, false, true]);
  });

  it('without a budget only one heavy model stays loaded; which engines are scheduled', async () => {
    const unloaded: string[] = [];
    const s = new GpuScheduler({ unload: async (id) => void unloaded.push(id) });
    await s.run({ id: 'a', vram: 1 }, async () => 0);
    await s.run({ id: 'b', vram: 1 }, async () => 0);
    expect(unloaded).toEqual(['a']);
    await expect(s.run({ id: 'z', vram: 1 }, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await s.run({ id: 'b', vram: 1 }, async () => 'after')).toBe('after');
    expect(gpuNeed({ command: 'x' }, { runtime: { where: 'local', device: ['cuda', 'cpu'], vram_gb: 4 } })).toEqual({ device: 'cuda:0', vram: 4 });
    expect(gpuNeed({ command: 'x' }, { runtime: { where: 'local', device: ['mps'], vram_gb: 6 } })).toEqual({ device: 'mps', vram: 6 });
    expect(gpuNeed({ url: 'https://gpu.example' }, { runtime: { where: 'local', device: ['cuda'], vram_gb: 4 } })).toBeNull();
    expect(gpuNeed({ command: 'x' }, { runtime: { where: 'local', device: ['cpu'] } })).toBeNull();
  });
});
