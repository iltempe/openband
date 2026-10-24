import { describe, expect, it } from 'vitest';
import { Compressor, SidechainDucker, TruePeakLimiter } from './worklets/master-dsp.js';
import { loudness, truePeak } from '../analysis/loudness';
import { reachLoudness } from './loudnessTarget';

const fs = 48000;
/** Run a limiter over whole channels in 128-frame blocks, compensating its latency. */
function limit(chs: Float32Array[], o: { ceilingDb: number; inputGainDb?: number; releaseMs?: number }) {
  const lim = new TruePeakLimiter(fs, { channels: chs.length, ...o });
  const n = chs[0].length + lim.latency;
  const out = chs.map(() => new Float32Array(n));
  for (let i = 0; i < n; i += 128) {
    const len = Math.min(128, n - i);
    const inp = chs.map((c) => { const b = new Float32Array(len); b.set(c.subarray(i, Math.min(c.length, i + len))); return b; });
    const o2 = chs.map(() => new Float32Array(len));
    lim.process(inp, o2);
    o2.forEach((b, c) => out[c].set(b, i));
  }
  return { out: out.map((c) => c.subarray(lim.latency, lim.latency + chs[0].length)), latency: lim.latency };
}

// Three "genres": a dense square-ish bass + kick, a pad with transients, sparse plucks with sharp peaks.
function fixture(kind: 'edm' | 'pad' | 'pluck', seconds = 6) {
  const n = fs * seconds;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let seed = 9;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    let v = 0;
    if (kind === 'edm') {
      const beat = t % 0.5;
      v = 0.9 * Math.exp(-beat * 18) * Math.sin(2 * Math.PI * (55 + 120 * Math.exp(-beat * 30)) * t) + 0.35 * Math.sign(Math.sin(2 * Math.PI * 110 * t)) * 0.6;
    } else if (kind === 'pad') v = 0.3 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t)) + (t % 1 < 0.01 ? rnd() * 0.9 : 0);
    else {
      const ph = t % 0.375;
      v = 0.95 * Math.exp(-ph * 25) * Math.sin(2 * Math.PI * 880 * ph) + 0.02 * rnd();
    }
    l[i] = v;
    r[i] = v * 0.9 + 0.05 * Math.sin(2 * Math.PI * 3 * t);
  }
  return [l, r];
}

/** The iteration the master chain uses (loudnessTarget.ts), over the limiter alone. */
async function reachTarget(chs: Float32Array[], target: number, ceilingDb: number) {
  let out: Float32Array[] = chs;
  const r = await reachLoudness((gainDb) => {
    out = limit(chs, { ceilingDb, inputGainDb: gainDb }).out;
    return loudness(out, fs).integrated;
  }, loudness(chs, fs).integrated, target);
  expect(r.iterations).toBeLessThanOrEqual(4);
  return out;
}

describe('true-peak limiter', () => {
  // Each genre with the targets it is mastered to (a sparse pluck can't be pushed to −9 LUFS without
  // destroying it; the master chain reports such targets as out of reach).
  const TARGETS = { edm: [[-9, -0.5], [-14, -1]], pad: [[-14, -1], [-16, -1]], pluck: [[-14, -1], [-16, -1]] } as const;
  for (const kind of ['edm', 'pad', 'pluck'] as const) {
    it(`${kind}: nothing over the ceiling in 4× true peak, and the loudness target within ±0.3 LU`, async () => {
      const chs = fixture(kind);
      for (const [target, ceiling] of TARGETS[kind]) {
        const out = await reachTarget(chs, target, ceiling);
        const tp = 20 * Math.log10(Math.max(...out.map((c) => truePeak(c))));
        expect(tp, `${kind} ${target} LUFS: true peak ${tp.toFixed(2)} dBTP`).toBeLessThanOrEqual(ceiling + 0.05);
        expect(Math.abs(loudness(out, fs).integrated - target), `${kind} ${target}`).toBeLessThanOrEqual(0.3);
      }
    });
  }

  it('is transparent below the ceiling (only delayed), and its latency is about 5 ms', () => {
    const x = new Float32Array(fs).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / fs));
    const { out, latency } = limit([x, x], { ceilingDb: -1 });
    expect(latency).toBe(Math.round(0.005 * fs) + 12);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(out[0][i] - x[i]));
    expect(err).toBeLessThan(1e-6);
  });

  it('has no clicks: the gain moves smoothly into a sudden peak', () => {
    const x = new Float32Array(fs / 2);
    for (let i = 0; i < x.length; i++) x[i] = (i > fs / 4 ? 1.6 : 0.2) * Math.sin((2 * Math.PI * 200 * i) / fs);
    const { out } = limit([x, x], { ceilingDb: -1 });
    // The largest sample-to-sample step stays near the sine's own.
    let step = 0;
    for (let i = 1; i < out[0].length; i++) step = Math.max(step, Math.abs(out[0][i] - out[0][i - 1]));
    expect(step).toBeLessThan(0.05);
  });
});

describe('sidechain ducker', () => {
  it('ducks the signal while the key plays, by the compressor curve times the amount', () => {
    const n = fs;
    const sig = new Float32Array(n).fill(0.5);
    const key = new Float32Array(n);
    for (let i = fs / 4; i < fs / 2; i++) key[i] = 0.9; // -0.9 dBFS for 250 ms
    for (const amount of [1, 0.5, 0]) {
      const d = new SidechainDucker(fs);
      d.set({ threshold: -20, ratio: 4, attack: 0.002, release: 0.05, amount });
      const out = [new Float32Array(n)];
      d.process([sig], [key], out);
      const ducked = out[0][Math.floor(fs * 0.45)];
      const expectDb = -(-0.9 + 20) * (1 - 1 / 4) * amount;
      expect(20 * Math.log10(ducked / 0.5)).toBeCloseTo(expectDb, 0);
      expect(out[0][Math.floor(fs * 0.9)]).toBeCloseTo(0.5, 2); // released
    }
  });
});

describe('compressor (the same DSP live and offline)', () => {
  it('a steady tone is reduced by the static curve, with a continuous soft knee and no hidden make-up', () => {
    const c = new Compressor(fs);
    c.set({ threshold: -20, ratio: 4, attack: 0.002, release: 0.05, knee: 6, makeup: 0 });
    // Soft knee: continuous, and equal to the hard curve outside it.
    expect(c.reduction(-30)).toBe(0);
    expect(c.reduction(-23)).toBeCloseTo(0, 6);
    expect(c.reduction(-17)).toBeCloseTo(3 * 0.75, 6);
    expect(c.reduction(-10)).toBeCloseTo(10 * 0.75, 6);
    const x = new Float32Array(fs).fill(0.5); // −6 dBFS
    const out = [new Float32Array(fs)];
    c.process([x], null, out);
    const db = 20 * Math.log10(out[0][fs - 1] / 0.5);
    expect(db).toBeCloseTo(-(-6.02 + 20) * 0.75, 1);
    // Make-up is exactly what it says.
    const m = new Compressor(fs);
    m.set({ threshold: -20, ratio: 4, attack: 0.002, release: 0.05, knee: 6, makeup: 4 });
    const out2 = [new Float32Array(fs)];
    m.process([x], null, out2);
    expect(20 * Math.log10(out2[0][fs - 1] / out[0][fs - 1])).toBeCloseTo(4, 3);
  });

  it('gives the same output whatever the block size (live quanta, offline renders)', () => {
    const x = Float32Array.from({ length: fs }, (_, i) => Math.sin(i / 7) * (i % 9000 < 3000 ? 0.9 : 0.1));
    const run = (block: number) => {
      const c = new Compressor(fs);
      c.set({ threshold: -24, ratio: 6, attack: 0.003, release: 0.1 });
      const out = new Float32Array(fs);
      for (let i = 0; i < fs; i += block) {
        const o = [new Float32Array(Math.min(block, fs - i))];
        c.process([x.subarray(i, i + o[0].length)], null, o);
        out.set(o[0], i);
      }
      return out;
    };
    const a = run(128);
    const b = run(1000);
    let d = 0;
    for (let i = 0; i < fs; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    expect(d).toBe(0);
  });
});
