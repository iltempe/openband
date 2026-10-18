// Radix-2 FFT (in place, complex) and helpers for real signals. No dependencies.

/** In-place iterative FFT. re/im length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  if (n & (n - 1)) throw new Error('FFT size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();
export function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Power spectrum of one Hann-windowed frame, n/2+1 bins, scaled so that a sine of amplitude A
 * contributes A²/2 summed over its bins (i.e. bin values add up to the frame's mean square).
 */
export function powerSpectrum(signal: Float32Array | Float64Array, offset: number, n: number, out?: Float64Array): Float64Array {
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const x = offset + i < signal.length ? signal[offset + i] : 0;
    re[i] = x * w[i];
    wsum += w[i] * w[i];
  }
  fft(re, im);
  const half = n / 2;
  const p = out ?? new Float64Array(half + 1);
  const norm = 1 / (n * wsum);
  for (let k = 0; k <= half; k++) {
    const v = (re[k] * re[k] + im[k] * im[k]) * norm;
    p[k] = k === 0 || k === half ? v : 2 * v;
  }
  return p;
}

export const binHz = (k: number, n: number, sampleRate: number) => (k * sampleRate) / n;
