import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runConformance } from './conformance.mjs';
import { conditioningFor } from './lib/mrt.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const node = process.execPath;
const fake = (...flags: string[]) => JSON.stringify([node, path.join(here, 'fixtures', 'fake-mrt-worker.mjs'), ...flags]);

describe('OMEP stream 1.0 (stream.jam)', () => {
  it('the mock streaming engine passes the streaming suite on a jittery network', async () => {
    const r = await runConformance({ command: node, args: [path.join(here, 'mock-stream-engine.mjs'), '--latency', '30', '--jitter', '40'] });
    const failed = r.checks.filter((c) => c.required && !c.ok);
    expect(failed).toEqual([]);
    expect(r.cases[0]).toMatchObject({ capability: 'stream.jam', adherence: 1 });
  }, 30000);

  it('omep-magenta-rt speaks OMEP and the stream protocol around its worker (a stand-in here)', async () => {
    const r = await runConformance({ command: node, args: [path.join(here, 'magenta-rt-engine.mjs'), '--worker', fake()] });
    const failed = r.checks.filter((c) => c.required && !c.ok);
    expect(failed).toEqual([]);
  }, 30000);

  it('omep-magenta-rt says what to install when the model is missing', async () => {
    const r = await runConformance({ command: node, args: [path.join(here, 'magenta-rt-engine.mjs'), '--worker', fake('--fail')] });
    const open = r.checks.find((c) => c.id === 'stream.jam: contribution is valid');
    expect(open?.ok).toBe(false);
    expect(open?.detail).toMatch(/mrt models init/);
  }, 30000);

  it('a slower-than-real-time model shows as frames that cannot keep up', async () => {
    const r = await runConformance({ command: node, args: [path.join(here, 'magenta-rt-engine.mjs'), '--worker', fake('--slow', '80')] });
    expect(r.checks.find((c) => c.id === 'stream.jam: keeps up with real time')?.ok).toBe(false);
  }, 30000);

  it('MRT2 hears the beat as drum onsets and the chords as a piano roll with an onset per bar', () => {
    const fb = (1920 / 48000) * 2; // a 40 ms frame at 120 BPM, in beats
    const at = (beat: number, intensity = 0.5) => conditioningFor(beat, 1920, 120, { chords: ['C', 'Am'], intensity });
    expect(at(0).drums).toBe(1);
    expect(at(fb).drums).toBe(0);
    expect(at(1 - fb / 2).drums).toBe(1); // beat 1 falls inside this frame
    expect(at(0.5, 0.8).drums).toBe(1); // eighths at high intensity
    expect(at(0.5, 0.1).drums).toBe(-1); // the model keeps its own time
    const c = at(0).notes!;
    expect(c[60]).toBe(2);
    expect(c[64]).toBe(2);
    expect(c[67]).toBe(2);
    expect(at(fb).notes![60]).toBe(1);
    const am = at(4).notes!;
    expect(am[57 + 12]).toBe(2); // A
    expect(am[60]).toBe(2); // C
    expect(am[64]).toBe(2); // E
    expect(am[67]).toBe(0);
    expect(conditioningFor(0, 1920, 120, {}).notes).toBeNull();
  });
});
