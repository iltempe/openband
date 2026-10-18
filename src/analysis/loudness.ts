// ITU-R BS.1770-4 / EBU R128 loudness, true peak and level statistics.

export interface LoudnessStats {
  /** Integrated loudness, LUFS (−Infinity for silence). */
  integrated: number;
  /** Highest short-term (3 s) loudness. */
  shortTermMax: number;
  /** Loudness range, LU. */
  lra: number;
  /** True peak (4× oversampled), dBTP. */
  truePeak: number;
  /** Sample peak, dBFS. */
  samplePeak: number;
  /** RMS level of the mono mix, dBFS. */
  rms: number;
  /** Peak − RMS, dB. */
  crest: number;
  /** Samples at or above full scale. */
  clipped: number;
  /** Momentary (400 ms) loudness every 100 ms, LUFS. */
  momentary: number[];
}

type Biquad = [b0: number, b1: number, b2: number, a1: number, a2: number];

/** K-weighting for any sample rate (the BS.1770 filters re-derived from their analog prototypes). */
export function kWeighting(fs: number): [Biquad, Biquad] {
  // Stage 1: high shelf (head acoustics).
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const fc = 1681.974450955533;
  const A = Math.pow(10, G / 40);
  let w0 = (2 * Math.PI * fc) / fs;
  let alpha = Math.sin(w0) / (2 * Q);
  let cos = Math.cos(w0);
  const sa = 2 * Math.sqrt(A) * alpha;
  let a0 = A + 1 - (A - 1) * cos + sa;
  const shelf: Biquad = [
    (A * (A + 1 + (A - 1) * cos + sa)) / a0,
    (-2 * A * (A - 1 + (A + 1) * cos)) / a0,
    (A * (A + 1 + (A - 1) * cos - sa)) / a0,
    (2 * (A - 1 - (A + 1) * cos)) / a0,
    (A + 1 - (A - 1) * cos - sa) / a0,
  ];
  // Stage 2: RLB high-pass.
  const Qh = 0.5003270373238773;
  const fh = 38.13547087602444;
  w0 = (2 * Math.PI * fh) / fs;
  alpha = Math.sin(w0) / (2 * Qh);
  cos = Math.cos(w0);
  a0 = 1 + alpha;
  const hp: Biquad = [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  return [shelf, hp];
}

function filter(x: Float32Array, [b0, b1, b2, a1, a2]: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

const lufsOf = (ms: number) => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);
const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** Per-block mean square (sum over channels of K-weighted power), blocks of `win` s every `hop` s. */
function blockPowers(weighted: Float64Array[], fs: number, win: number, hop: number): number[] {
  const n = weighted[0]?.length ?? 0;
  const size = Math.round(win * fs);
  const step = Math.round(hop * fs);
  const out: number[] = [];
  if (n < size) {
    if (n === 0) return out;
    let s = 0;
    for (const ch of weighted) for (let i = 0; i < n; i++) s += ch[i] * ch[i];
    return [s / size];
  }
  // Prefix sums of the channel-summed power make each block O(1).
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of weighted) p += ch[i] * ch[i];
    prefix[i + 1] = prefix[i] + p;
  }
  for (let start = 0; start + size <= n; start += step) out.push((prefix[start + size] - prefix[start]) / size);
  return out;
}

function gated(powers: number[], relativeLU: number): number[] {
  const abs = powers.filter((p) => lufsOf(p) > -70);
  if (!abs.length) return [];
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
  const threshold = lufsOf(mean) + relativeLU;
  return abs.filter((p) => lufsOf(p) > threshold);
}

/** 4× oversampled peak with a windowed-sinc interpolator (48 taps per phase). */
export function truePeak(x: Float32Array): number {
  const phases = 4;
  const taps = 12;
  const kernel: number[][] = [];
  for (let ph = 1; ph < phases; ph++) {
    const frac = ph / phases;
    const k: number[] = [];
    for (let t = -taps; t < taps; t++) {
      const d = t + 1 - frac; // distance from sample i+t+1 to the interpolation point i+frac
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * d) / (taps + 1));
      k.push(sinc * win);
    }
    kernel.push(k);
  }
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  // Interpolate only around loud samples: a true peak can't be far above its neighbours.
  const near = peak * 0.5;
  for (let i = 0; i < x.length - 1; i++) {
    if (Math.abs(x[i]) < near && Math.abs(x[i + 1]) < near) continue;
    for (const k of kernel) {
      let s = 0;
      for (let t = -taps; t < taps; t++) {
        const j = i + t + 1;
        if (j >= 0 && j < x.length) s += x[j] * k[t + taps];
      }
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

export function loudness(channels: Float32Array[], fs: number): LoudnessStats {
  const [shelf, hp] = kWeighting(fs);
  const weighted = channels.map((ch) => filter(new Float32Array(filter(ch, shelf)), hp));
  const momentaryP = blockPowers(weighted, fs, 0.4, 0.1);
  const shortP = blockPowers(weighted, fs, 3, 0.1);
  const g = gated(momentaryP, -10);
  const integrated = g.length ? lufsOf(g.reduce((a, b) => a + b, 0) / g.length) : -Infinity;
  const shortTermMax = shortP.length ? Math.max(...shortP.map(lufsOf)) : -Infinity;
  const st = gated(shortP, -20)
    .map(lufsOf)
    .sort((a, b) => a - b);
  const lra = st.length > 1 ? st[Math.floor(0.95 * (st.length - 1))] - st[Math.floor(0.1 * (st.length - 1))] : 0;

  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  const n = channels[0]?.length ?? 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const ch of channels) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      if (a >= 1) clipped++;
      m += ch[i];
    }
    m /= channels.length || 1;
    sumSq += m * m;
  }
  const rms = n ? db(Math.sqrt(sumSq / n)) : -Infinity;
  const tp = Math.max(0, ...channels.map(truePeak));
  return {
    integrated,
    shortTermMax,
    lra,
    truePeak: db(tp),
    samplePeak: db(peak),
    rms,
    crest: Number.isFinite(rms) ? db(peak) - rms : 0,
    clipped,
    momentary: momentaryP.map(lufsOf),
  };
}
