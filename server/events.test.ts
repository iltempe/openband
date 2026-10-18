import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module shared with the MCP server
import { EventBuffer } from './events.mjs';

describe('EventBuffer', () => {
  it('assigns increasing ids and keeps at most capacity events', () => {
    const b = new EventBuffer(3);
    for (let i = 0; i < 5; i++) b.push({ kind: 'selection', i });
    const { events, last_id } = b.list();
    expect(last_id).toBe(5);
    expect(events.map((e: { id: number }) => e.id)).toEqual([3, 4, 5]);
  });

  it('filters by since_id and kinds', () => {
    const b = new EventBuffer();
    b.push({ kind: 'phrase' });
    b.push({ kind: 'selection' });
    b.push({ kind: 'phrase' });
    expect(b.list({ since_id: 1, kinds: ['phrase'] }).events.map((e: { id: number }) => e.id)).toEqual([3]);
  });

  it('wait_for_event resolves on a matching event', async () => {
    const b = new EventBuffer();
    const p = b.wait({ kinds: ['phrase'], timeout_ms: 1000 });
    b.push({ kind: 'selection' });
    b.push({ kind: 'phrase', notes: [] });
    await expect(p).resolves.toMatchObject({ kind: 'phrase', id: 2 });
  });

  it('wait_for_event times out', async () => {
    vi.useFakeTimers();
    const b = new EventBuffer();
    const p = b.wait({ kinds: ['ab_result'], timeout_ms: 5000 });
    vi.advanceTimersByTime(5001);
    await expect(p).resolves.toMatchObject({ timeout: true });
    vi.useRealTimers();
  });

  it('returns a buffered event newer than since_id immediately', async () => {
    const b = new EventBuffer();
    b.push({ kind: 'ask', text: 'why?' });
    await expect(b.wait({ since_id: 0, kinds: ['ask'] })).resolves.toMatchObject({ text: 'why?' });
  });

  it('caps the timeout at 60 s', async () => {
    vi.useFakeTimers();
    const b = new EventBuffer();
    const p = b.wait({ timeout_ms: 999999 });
    vi.advanceTimersByTime(60001);
    await expect(p).resolves.toMatchObject({ timeout: true });
    vi.useRealTimers();
  });
});
