import { describe, expect, it } from 'vitest';
import { kWeighting, loudness } from './loudness';
import { StreamingLoudness, TARGETS, targetStatus, type BiquadCoeffs } from './liveLoudness';
import { loudnessWorkletSource } from '../audio/worklets/loudness.worklet';
import { compareLoudness } from '../levelMatch';

const FS = 48000;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

function sine(seconds: number, freq: number, dbfs: number, phase = 0) {
  const a = Math.pow(10, dbfs / 20);
  return Float32Array.from({ length: Math.round(seconds * FS) }, (_, i) => a * Math.sin((2 * Math.PI * freq * i) / FS + phase));
}
function noise(seconds: number, dbfs: number) {
  const a = Math.pow(10, dbfs / 20) * Math.sqrt(3);
  return Float32Array.from({ length: Math.round(seconds * FS) }, () => a * rnd());
}
const concat = (...xs: Float32Array[]) => {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) out.set(x, (o += x.length) - x.length);
  return out;
};

const mix = (a: Float32Array, b: Float32Array) => Float32Array.from(a, (v, i) => v + b[i]);

/** Run the streaming meter as the worklet would: 128-frame quanta. */
function stream(channels: Float32Array[], Ctor: typeof StreamingLoudness = StreamingLoudness) {
  const m = new Ctor(FS, kWeighting(FS) as unknown as BiquadCoeffs[], 2);
  for (let i = 0; i < channels[0].length; i += 128) m.push(channels.map((c) => c.subarray(i, i + 128)));
  return m.read();
}

describe('live loudness meter vs the offline measurement', () => {
  const cases: [string, Float32Array[]][] = [
    ['1 kHz sine −20 dBFS, stereo', [sine(6, 1000, -20), sine(6, 1000, -20)]],
    ['noise −18 dBFS, one channel', [noise(6, -18), new Float32Array(6 * FS)]],
    ['loud and quiet parts (gating)', [concat(sine(4, 440, -12), sine(4, 440, -40), noise(4, -24)), concat(sine(4, 440, -12), sine(4, 440, -40), noise(4, -24))]],
    ['100 Hz + 5 kHz (K-weighting)', [mix(sine(5, 100, -16), sine(5, 5000, -22)), sine(5, 100, -16)]],
  ];
  for (const [name, ch] of cases) {
    it(name, () => {
      const off = loudness(ch, FS);
      const live = stream(ch);
      expect(Math.abs(live.integrated - off.integrated), `integrated ${live.integrated} vs ${off.integrated}`).toBeLessThanOrEqual(0.3);
      expect(Math.abs(live.momentary - off.momentary[off.momentary.length - 1])).toBeLessThanOrEqual(0.3);
      expect(Math.abs(live.truePeakMax - off.truePeak), `true peak ${live.truePeakMax} vs ${off.truePeak}`).toBeLessThanOrEqual(0.1);
    });
  }

  it('short-term over a steady signal, the reference level, inter-sample peaks and reset', () => {
    // BS.1770: a 997 Hz sine at 0 dBFS in one channel reads −3.01 LUFS; in both channels (EBU's −23 dBFS reference) +3 dB.
    const ref = stream([sine(4, 997, 0), new Float32Array(4 * FS)]);
    expect(Math.abs(ref.shortTerm + 3.01)).toBeLessThan(0.05);
    const ebu = stream([sine(4, 997, -23), sine(4, 997, -23)]);
    expect(Math.abs(ebu.integrated + 23.0)).toBeLessThan(0.1);
    // The published 48 kHz coefficients.
    const [shelf, hp] = kWeighting(48000);
    expect(shelf.map((x) => +x.toFixed(6))).toEqual([1.535125, -2.691696, 1.198393, -1.690659, 0.732481]);
    expect(hp.map((x) => +x.toFixed(6))).toEqual([1, -2, 1, -1.990047, 0.990072]);
    // A sine at fs/4 with a 45° phase peaks between samples: true peak > sample peak.
    const tp = sine(1, FS / 4, -6, Math.PI / 4);
    const live = stream([tp, tp]);
    expect(live.truePeakMax).toBeGreaterThan(-6.5);
    expect(Math.abs(live.truePeakMax - loudness([tp, tp], FS).truePeak)).toBeLessThan(0.15);
    // Not enough audio yet: no short-term value.
    expect(stream([sine(1, 1000, -20), sine(1, 1000, -20)]).shortTerm).toBe(-Infinity);
    const m = new StreamingLoudness(FS, kWeighting(FS) as unknown as BiquadCoeffs[], 2);
    const loud = sine(2, 1000, -10);
    for (let i = 0; i < loud.length; i += 128) m.push([loud.subarray(i, i + 128)]);
    m.reset();
    expect(m.read().integrated).toBe(-Infinity);
    expect(m.read().truePeakMax).toBe(-Infinity);
  });

  it('the worklet carries the same class, self-contained', () => {
    const src = loudnessWorkletSource();
    expect(src).toContain("registerProcessor('openband-loudness'");
    // Evaluated without any module scope (as in the worklet), it measures the same.
    const Ctor = new Function(`${src.split('\nclass OpenBandLoudness')[0]}; return StreamingLoudness;`)() as typeof StreamingLoudness;
    const ch = [sine(5, 1000, -20), sine(5, 1000, -20)];
    expect(stream(ch, Ctor).integrated).toBeCloseTo(stream(ch).integrated, 6);
  });
});

describe('targets and level match', () => {
  it('colours the meter against the target', () => {
    const streaming = TARGETS.find((t) => t.id === 'streaming')!;
    expect(targetStatus(-14.4, -2, streaming)).toBe('green');
    expect(targetStatus(-16, -2, streaming)).toBe('yellow');
    expect(targetStatus(-9, -2, streaming)).toBe('red');
    expect(targetStatus(-14, -0.5, streaming)).toBe('red'); // over the true-peak ceiling
    expect(targetStatus(-Infinity, -Infinity, streaming)).toBe('idle');
  });

  it('measures what an effect adds, over the same 3 s', () => {
    const dry = [noise(3, -24), noise(3, -24)];
    const wet = dry.map((c) => Float32Array.from(c, (v) => v * Math.pow(10, 2.1 / 20)));
    const r = compareLoudness(wet, dry, FS);
    expect(r.gain).toBeCloseTo(2.1, 1);
    expect(() => compareLoudness([new Float32Array(3 * FS)], dry, FS)).toThrow(/Nothing plays/);
  });
});
