// Master and sidechain DSP (G1), plain JavaScript on purpose: the source text is copied as-is into the
// AudioWorklet (imported with ?raw) and also imported by the tests, so live, offline render and tests run
// the very same code. Self-contained: nothing from outside these classes.

/**
 * True-peak limiter with lookahead. Detection: 4× oversampled peak (the windowed-sinc interpolator of
 * the meters, 12 taps a side). Gain: for each sample, the gain it needs (ceiling / its true peak); the
 * minimum of that over the next `lookahead` samples; then a moving average over the same length — a
 * smooth ramp that reaches full reduction exactly when the peak plays, and never above what any sample
 * in the window needs, so the ceiling holds. Release: exponential, slower when the reduction lasts.
 * Latency: lookahead + 12 samples (`latency`).
 * Linked (export of stems): with a `key` the gain is computed from the key (the full mix) and applied to
 * the input, so stems through linked limiters add up to the limited mix.
 */
export class TruePeakLimiter {
  constructor(fs, o = {}) {
    this.fs = fs;
    this.ch = o.channels || 2;
    this.L = Math.max(32, Math.round(((o.lookaheadMs ?? 5) * fs) / 1000));
    this.T = 12;
    this.kernel = [];
    for (let ph = 1; ph < 4; ph++) {
      const frac = ph / 4;
      const k = new Float64Array(2 * this.T);
      for (let t = -this.T; t < this.T; t++) {
        const d = t + 1 - frac;
        const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
        k[t + this.T] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / (this.T + 1)));
      }
      this.kernel.push(k);
    }
    // History of the (input-gained) signal, per channel, long enough for the delay and the interpolator.
    this.R = 1;
    while (this.R < this.L + 3 * this.T + 4) this.R *= 2;
    this.mask = this.R - 1;
    this.hist = [];
    for (let c = 0; c < this.ch; c++) this.hist.push(new Float64Array(this.R));
    this.khist = [];
    for (let c = 0; c < this.ch; c++) this.khist.push(new Float64Array(this.R));
    this.n = 0; // samples written
    // Sliding minimum (monotonic deque) of the needed gain over L + 1 samples.
    this.dqIdx = new Float64Array(this.L + 4);
    this.dqVal = new Float64Array(this.L + 4);
    this.dqHead = 0;
    this.dqLen = 0;
    this.dqCap = this.L + 4;
    // Moving average of that minimum over L samples.
    this.box = new Float64Array(this.L).fill(1);
    this.boxSum = this.L;
    this.boxPos = 0;
    this.g = 1;
    this.held = 0;
    this.set(o);
  }

  get latency() {
    return this.L + this.T;
  }

  set(o = {}) {
    if (o.ceilingDb !== undefined) this.ceil = Math.pow(10, o.ceilingDb / 20);
    if (this.ceil === undefined) this.ceil = Math.pow(10, -1 / 20);
    if (o.releaseMs !== undefined) this.releaseMs = Math.max(5, o.releaseMs);
    if (this.releaseMs === undefined) this.releaseMs = 120;
    if (o.inputGainDb !== undefined) this.inGain = Math.pow(10, o.inputGainDb / 20);
    if (this.inGain === undefined) this.inGain = 1;
    if (o.on !== undefined) this.on = !!o.on;
    if (this.on === undefined) this.on = true;
  }

  /** Needed gain of sample k (its true peak is known once k + T has arrived). */
  needed(k) {
    let peak = 0;
    const T = this.T;
    for (let c = 0; c < this.ch; c++) {
      const h = this.keyed ? this.khist[c] : this.hist[c];
      const a = Math.abs(h[k & this.mask]);
      if (a > peak) peak = a;
      const b = Math.abs(h[(k + 1) & this.mask]);
      // Interpolate only near loud samples: a true peak can't be far above its neighbours.
      if (Math.max(a, b) * 2 < this.ceil) continue;
      for (let p = 0; p < 3; p++) {
        const kk = this.kernel[p];
        let s = 0;
        for (let t = -T; t < T; t++) s += h[(k + t + 1) & this.mask] * kk[t + T];
        const v = Math.abs(s);
        if (v > peak) peak = v;
      }
    }
    return peak > this.ceil ? this.ceil / peak : 1;
  }

  /** Process one block: input and output channel arrays (output may be the same arrays); `key` links it. */
  process(input, output, key) {
    this.keyed = !!(key && key.length);
    const n = (output[0] || input[0]).length;
    const L = this.L;
    const D = this.L + this.T;
    const relBase = this.releaseMs / 1000;
    for (let i = 0; i < n; i++) {
      const w = this.n & this.mask;
      for (let c = 0; c < this.ch; c++) {
        const x = input[c] ? input[c][i] : input[0] ? input[0][i] : 0;
        this.hist[c][w] = x * this.inGain;
        if (this.keyed) this.khist[c][w] = (key[c] ? key[c][i] : key[0][i]) * this.inGain;
      }
      // Sample k = n − T now has its full interpolation neighbourhood.
      const k = this.n - this.T;
      let gNeed = 1;
      if (k >= 0) gNeed = this.on ? this.needed(k) : 1;
      // Sliding min over [k − L, k]: m(k − L).
      while (this.dqLen && this.dqVal[(this.dqHead + this.dqLen - 1) % this.dqCap] >= gNeed) this.dqLen--;
      this.dqIdx[(this.dqHead + this.dqLen) % this.dqCap] = k;
      this.dqVal[(this.dqHead + this.dqLen) % this.dqCap] = gNeed;
      this.dqLen++;
      while (this.dqIdx[this.dqHead] < k - L) {
        this.dqHead = (this.dqHead + 1) % this.dqCap;
        this.dqLen--;
      }
      const m = this.dqVal[this.dqHead];
      // Average of the last L minima: the gain for output sample o = k − L = n − D.
      this.boxSum += m - this.box[this.boxPos];
      this.box[this.boxPos] = m;
      this.boxPos = (this.boxPos + 1) % L;
      const a = Math.min(1, this.boxSum / L);
      if (a < this.g) this.g = a;
      else {
        // Release: slower the longer the reduction has lasted (up to 4×).
        const r = relBase * (1 + Math.min(3, this.held / (0.1 * this.fs)));
        this.g = Math.min(a, this.g + (a - this.g) * (1 - Math.exp(-1 / (r * this.fs))));
      }
      this.held = this.g < 0.999 ? this.held + 1 : 0;
      const o = this.n - D;
      for (let c = 0; c < output.length; c++) {
        const src = this.hist[Math.min(c, this.ch - 1)];
        output[c][i] = o >= 0 ? src[o & this.mask] * this.g : 0;
      }
      this.n++;
    }
  }

  /** Current gain reduction in dB (≤ 0). */
  get reductionDb() {
    return 20 * Math.log10(Math.max(1e-6, this.g));
  }
}

/**
 * A feed-forward compressor: peak detector with attack / release, soft knee, threshold and ratio, a
 * smoothed gain. Keyed by its own signal, or by another one (sidechain: a kick ducking a bass), in which
 * case `amount` (0..1) scales the reduction. No hidden make-up gain: what `makeup` says is what you get.
 * Deterministic and independent of the block size, so live playback and offline render agree.
 */
export class Compressor {
  constructor(fs) {
    this.fs = fs;
    this.env = 0;
    this.gain = 1;
    this.grDb = 0;
    this.smooth = Math.exp(-1 / (0.001 * fs));
    this.set({ threshold: -24, ratio: 4, attack: 0.005, release: 0.15, knee: 6, makeup: 0, amount: 1 });
  }

  set(o = {}) {
    if (o.threshold !== undefined) this.threshold = o.threshold;
    if (o.ratio !== undefined) this.ratio = Math.max(1, o.ratio);
    if (o.attack !== undefined) this.aCoef = Math.exp(-1 / (Math.max(0.0005, o.attack) * this.fs));
    if (o.release !== undefined) this.rCoef = Math.exp(-1 / (Math.max(0.005, o.release) * this.fs));
    if (o.knee !== undefined) this.knee = Math.max(0, o.knee);
    if (o.makeup !== undefined) this.makeupGain = Math.pow(10, o.makeup / 20);
    if (o.amount !== undefined) this.amount = Math.max(0, Math.min(1, o.amount));
  }

  /** Gain reduction (dB ≥ 0) for a detector level in dB, with a quadratic soft knee. */
  reduction(db) {
    const over = db - this.threshold;
    const slope = 1 - 1 / this.ratio;
    const k = this.knee;
    if (k > 0 && Math.abs(over) <= k / 2) return (slope * (over + k / 2) * (over + k / 2)) / (2 * k);
    return over > 0 ? over * slope : 0;
  }

  /** signal (and optionally key) as channel arrays; writes `output`. Without a key the signal keys itself. */
  process(signal, key, output) {
    const n = output[0].length;
    const det = key && key.length ? key : signal;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < det.length; c++) {
        const a = Math.abs(det[c][i]);
        if (a > v) v = a;
      }
      this.env = v > this.env ? v + (this.env - v) * this.aCoef : v + (this.env - v) * this.rCoef;
      const gr = this.reduction(20 * Math.log10(Math.max(1e-9, this.env))) * this.amount;
      const target = Math.pow(10, -gr / 20);
      this.gain = target + (this.gain - target) * this.smooth;
      const g = this.gain * this.makeupGain;
      for (let c = 0; c < output.length; c++) {
        const s = signal[c] ? signal[c][i] : signal[0] ? signal[0][i] : 0;
        output[c][i] = s * g;
      }
    }
    this.grDb = 20 * Math.log10(Math.max(1e-6, this.gain));
  }
}

/** Sidechain compression ("ducking") is the compressor keyed by another track, without knee or make-up. */
export class SidechainDucker extends Compressor {
  constructor(fs) {
    super(fs);
    this.set({ knee: 0, makeup: 0 });
  }
}
