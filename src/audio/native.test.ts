import { describe, expect, it } from 'vitest';
import { JitterBuffer, TestPlugin, TEST_PLUGINS } from './worklets/native-dsp.js';
import { migrate } from '../migrations';
import { emptyProject } from '../store';

const blocks = (x: Float32Array, n = 128) => Array.from({ length: Math.ceil(x.length / n) }, (_, i) => x.subarray(i * n, (i + 1) * n));

describe('native plugins: the in-process test host (G8.1)', () => {
  it('the latency plugin delays by exactly what it reports, block by block', () => {
    const p = new TestPlugin('org.openband.test.latency', { latency: 512 });
    expect(p.latency).toBe(512);
    const x = new Float32Array(2048);
    x[3] = 1;
    x[700] = -0.5;
    const out: number[] = [];
    for (const b of blocks(x)) {
      const o = [new Float32Array(b.length), new Float32Array(b.length)];
      p.process([b, b], o);
      out.push(...o[0]);
    }
    expect(out.indexOf(1)).toBe(515);
    expect(out.indexOf(-0.5)).toBe(1212);
    expect(new TestPlugin('org.openband.test.latency', { latency: 0 }).latency).toBe(0);
  });

  it('the gain plugin has no latency', () => {
    const p = new TestPlugin('org.openband.test.gain', { gain: -6 });
    expect(p.latency).toBe(0);
    const o = [new Float32Array(4)];
    p.process([Float32Array.of(1, 1, 1, 1)], o);
    expect(o[0][0]).toBeCloseTo(0.501, 3);
    expect(Object.keys(TEST_PLUGINS)).toContain('org.openband.test.gain');
    expect(() => new TestPlugin('nope')).toThrow(/Unknown test plugin/);
  });

  it('the jitter buffer plays each block exactly N blocks later, and counts late ones', () => {
    const j = new JitterBuffer(3);
    const played: (number | null)[] = [];
    for (let i = 0; i < 8; i++) {
      const { n, data } = j.next();
      played.push(data ? data[0][0] : null);
      // The host answers every block except number 4.
      if (n !== 4) j.put(n, [Float32Array.of(n)]);
    }
    expect(played).toEqual([null, null, null, 0, 1, 2, 3, null]);
    expect(j.underruns).toBe(1);
  });
});

describe('plugin formats in projects', () => {
  it('plugins saved before G8 are Web Audio Modules', () => {
    const p = emptyProject('x');
    p.tracks.push({ id: 't', name: 'T', kind: 'instrument', instrument: 'pluck', color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, reverb: 0, delay: 0, cutoff: 1, fx: { amp: { on: false, drive: 0, tone: 0, level: 0 }, eq: { on: false, low: 0, mid: 0, high: 0, midFreq: 1000 }, comp: { on: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.2, makeup: 0 }, plugins: [{ id: 's', url: 'https://x/index.js', name: 'X', on: true }] } });
    const m = migrate(JSON.parse(JSON.stringify(p)));
    expect(m.tracks[0].fx!.plugins![0].format).toBe('wam');
    // Idempotent, and native slots keep their format.
    m.tracks[0].fx!.plugins!.push({ id: 'n', url: '', name: 'N', on: true, format: 'clap', native: { id: 'com.u-he.diva' } });
    expect(migrate(m).tracks[0].fx!.plugins!.map((s) => s.format)).toEqual(['wam', 'clap']);
  });
});
