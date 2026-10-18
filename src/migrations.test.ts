import { describe, expect, it } from 'vitest';
import { migrate } from './migrations';
import { demoV1Raw } from './__fixtures__/projects';

describe('migrate', () => {
  it('upgrades the real v1 demo export to v2 without losing content', () => {
    const v1 = demoV1Raw as { tracks: unknown[]; regions: { notes: unknown[] }[]; name: string; bpm: number };
    const p = migrate(demoV1Raw, 1000);
    expect(p.version).toBe(2);
    expect(p.name).toBe(v1.name);
    expect(p.bpm).toBe(v1.bpm);
    expect(p.tracks).toEqual(v1.tracks);
    expect(p.regions).toEqual(v1.regions);
    expect(p.meta).toMatchObject({ createdAt: 1000, updatedAt: 1000 });
    expect(p.meta!.projectId).toMatch(/^song_/);
  });

  it('accepts JSON strings and is idempotent on v2', () => {
    const once = migrate(JSON.stringify(demoV1Raw));
    const twice = migrate(once);
    expect(twice).toEqual(once);
    expect(twice.meta!.projectId).toBe(once.meta!.projectId);
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(demoV1Raw);
    migrate(copy);
    expect(copy).toEqual(demoV1Raw);
  });

  it('fills defaults missing from very old saves', () => {
    const p = migrate({ version: 1, tracks: [], regions: [{ id: 'r', trackId: 't', name: 'r', start: 0, length: 4 }] });
    expect(p).toMatchObject({ name: 'Untitled', bpm: 110, key: 'C', masterVolume: 0.8, metronome: false });
    expect(p.regions[0].notes).toEqual([]);
  });

  it('rejects things that are not projects with a clear message', () => {
    expect(() => migrate('nope')).toThrow(/not valid JSON/);
    expect(() => migrate([1, 2])).toThrow(/expected a JSON object/);
    expect(() => migrate({ version: 1, tracks: {} })).toThrow(/"tracks" and "regions"/);
    expect(() => migrate({ version: 99, tracks: [], regions: [] })).toThrow(/newer OpenBand/);
  });
});
