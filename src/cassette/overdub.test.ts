import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { clapLatency, withOverdub } from './overdub';

describe('singing over a song', () => {
  it('measures a clap against the clicks, ignoring a miss', () => {
    expect(clapLatency([0, 500, 1000, 1500], [120, 620, 1115, 1900])).toBe(120);
    expect(clapLatency([0, 500], [])).toBeNull();
  });
  it('puts the take on a new track, its latency cut off the front', () => {
    const base = { bpm: 120, tracks: [], regions: [] } as unknown as Project;
    const { project, trackId } = withOverdub(base, { sampleId: 's', name: 'Luca', startS: 10, durationS: 5, latencyMs: 100 });
    const r = project.regions[0];
    expect(r.trackId).toBe(trackId);
    expect(r.start).toBe(20);
    expect(r.audio).toMatchObject({ offset: 0.1 });
    expect(r.length).toBeCloseTo(9.8);
    expect(base.tracks).toEqual([]);
  });
});
