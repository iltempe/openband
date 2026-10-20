// Live loudness DSP (F20), plain JavaScript on purpose: its source text is copied as-is into the
// AudioWorklet (imported with ?raw), so no bundler transform (class-field helpers, renamed imports) can
// break it there. Self-contained: nothing from outside this class. Tested against loudness.ts.
//
// BS.1770 streaming measurement: 100 ms blocks; momentary = the last 4, short-term = the last 30 (the
// offline 400 ms / 3 s windows with a 100 ms hop); integrated = gated over the momentary blocks since
// reset; true peak = 4× oversampled (24-tap windowed sinc) around loud samples.
export class StreamingLoudness {
  constructor(fs, kWeighting, channels = 2) {
    this.blockFill = 0;
    this.blockSum = 0;
    this.blocks = [];
    this.gatedPowers = [];
    this.taps = 12;
    this.kernel = [];
    this.histPos = 0;
    this.seen = 0;
    this.tpMax = 0;
    this.tpWindow = [];
    this.tpBlock = 0;
    this.sampleMax = 0;
    this.k = kWeighting;
    // Per channel, per biquad: x1 x2 y1 y2.
    this.z = new Float64Array(channels * kWeighting.length * 4);
    this.blockSize = Math.round(0.1 * fs);
    for (let ph = 1; ph < 4; ph++) {
      const frac = ph / 4;
      const kk = new Float64Array(2 * this.taps);
      for (let t = -this.taps; t < this.taps; t++) {
        const d = t + 1 - frac;
        const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
        kk[t + this.taps] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / (this.taps + 1)));
      }
      this.kernel.push(kk);
    }
    this.hist = [];
    for (let c = 0; c < channels; c++) this.hist.push(new Float64Array(2 * this.taps));
  }

  reset() {
    this.gatedPowers = [];
    this.tpMax = 0;
    this.sampleMax = 0;
  }

  /** Feed one render quantum: one Float32Array per channel (missing channels count as silence). */
  push(channels) {
    const n = channels[0] ? channels[0].length : 0;
    const nch = this.hist.length;
    const nb = this.k.length;
    for (let i = 0; i < n; i++) {
      let p = 0;
      for (let c = 0; c < nch; c++) {
        const x = channels[c] ? channels[c][i] : 0;
        // K-weighting (two biquads, direct form I)
        let v = x;
        for (let b = 0; b < nb; b++) {
          const q = this.k[b];
          const o = (c * nb + b) * 4;
          const y = q[0] * v + q[1] * this.z[o] + q[2] * this.z[o + 1] - q[3] * this.z[o + 2] - q[4] * this.z[o + 3];
          this.z[o + 1] = this.z[o];
          this.z[o] = v;
          this.z[o + 3] = this.z[o + 2];
          this.z[o + 2] = y;
          v = y;
        }
        p += v * v;
        this.peak(c, x);
      }
      this.histPos = (this.histPos + 1) % (2 * this.taps);
      this.seen++;
      this.blockSum += p;
      if (++this.blockFill === this.blockSize) this.endBlock();
    }
  }

  /** True peak: interpolate between the samples around a loud one (24-tap windowed sinc, 4 phases). */
  peak(c, x) {
    const h = this.hist[c];
    const L = 2 * this.taps;
    h[this.histPos] = x;
    const a = Math.abs(x);
    if (a > this.sampleMax) this.sampleMax = a;
    if (a > this.tpBlock) this.tpBlock = a;
    if (this.seen < L) return;
    // The point between samples i and i+1 needs samples i-taps+1 … i+taps: i is `taps` samples back.
    const i0 = (this.histPos - this.taps + L) % L;
    const i1 = (i0 + 1) % L;
    const near = this.sampleMax * 0.5;
    if (Math.abs(h[i0]) < near && Math.abs(h[i1]) < near) return;
    for (let k = 0; k < this.kernel.length; k++) {
      const kk = this.kernel[k];
      let s = 0;
      for (let t = 0; t < L; t++) s += h[(i0 - this.taps + 1 + t + L) % L] * kk[t];
      const v = Math.abs(s);
      if (v > this.tpBlock) this.tpBlock = v;
    }
  }

  endBlock() {
    this.blocks.push(this.blockSum / this.blockSize);
    if (this.blocks.length > 30) this.blocks.shift();
    this.blockSum = 0;
    this.blockFill = 0;
    if (this.blocks.length >= 4) {
      const m = this.mean(this.blocks.length - 4);
      if (m > 0 && -0.691 + 10 * Math.log10(m) > -70) this.gatedPowers.push(m);
    }
    this.tpWindow.push(this.tpBlock);
    if (this.tpWindow.length > 4) this.tpWindow.shift();
    if (this.tpBlock > this.tpMax) this.tpMax = this.tpBlock;
    this.tpBlock = 0;
  }

  mean(from) {
    let s = 0;
    for (let i = from; i < this.blocks.length; i++) s += this.blocks[i];
    return s / (this.blocks.length - from);
  }

  read() {
    const lufs = (ms) => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);
    const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
    const momentary = this.blocks.length >= 4 ? lufs(this.mean(this.blocks.length - 4)) : -Infinity;
    const shortTerm = this.blocks.length >= 30 ? lufs(this.mean(0)) : -Infinity;
    let integrated = -Infinity;
    const g = this.gatedPowers;
    if (g.length) {
      let s = 0;
      for (const p of g) s += p;
      const threshold = lufs(s / g.length) - 10;
      let sum = 0;
      let cnt = 0;
      for (const p of g)
        if (lufs(p) > threshold) {
          sum += p;
          cnt++;
        }
      if (cnt) integrated = lufs(sum / cnt);
    }
    let tp = 0;
    for (const v of this.tpWindow) if (v > tp) tp = v;
    return { momentary, shortTerm, integrated, truePeak: db(tp), truePeakMax: db(this.tpMax) };
  }
}
