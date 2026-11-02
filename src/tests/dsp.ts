// The measures that loudness.ts doesn't have. Pure.
const fft = (re: Float64Array, im: Float64Array) => {
  const n = re.length;
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
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
  }
};

const SIZE = 4096;

/** Average power per FFT bin. */
export function spectrum(x: Float32Array): Float64Array {
  const out = new Float64Array(SIZE / 2);
  const hops = Math.max(1, Math.min(200, Math.floor(x.length / SIZE)));
  const step = hops > 1 ? Math.floor((x.length - SIZE) / (hops - 1)) : 0;
  const re = new Float64Array(SIZE);
  const im = new Float64Array(SIZE);
  for (let h = 0; h < hops; h++) {
    const at = h * step;
    for (let i = 0; i < SIZE; i++) {
      re[i] = (x[at + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SIZE - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let i = 0; i < SIZE / 2; i++) out[i] += (re[i] ** 2 + im[i] ** 2) / hops;
  }
  return out;
}

const bins = (band: [number, number], sr: number) => [Math.max(1, Math.round((band[0] * SIZE) / sr)), Math.min(SIZE / 2 - 1, Math.round((band[1] * SIZE) / sr))];

export function bandEnergyDb(x: Float32Array, band: [number, number], sr: number) {
  const s = spectrum(x);
  const [a, b] = bins(band, sr);
  let e = 0;
  for (let i = a; i <= b; i++) e += s[i];
  return 10 * Math.log10(e / (SIZE * SIZE) + 1e-12);
}

/** How much of the band two parts both fill, 0..1: the shared energy over the quieter part's energy. */
export function masking(a: Float32Array, b: Float32Array, band: [number, number], sr: number) {
  const sa = spectrum(a);
  const sb = spectrum(b);
  const [lo, hi] = bins(band, sr);
  let aTotal = 0;
  let bTotal = 0;
  for (let i = lo; i <= hi; i++) (aTotal += sa[i]), (bTotal += sb[i]);
  if (aTotal < 1e-9 || bTotal < 1e-9) return 0;
  let shared = 0;
  for (let i = lo; i <= hi; i++) shared += Math.min(sa[i] / aTotal, sb[i] / bTotal);
  return shared;
}

export function correlation(l: Float32Array, r: Float32Array) {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < l.length; i++) (lr += l[i] * r[i]), (ll += l[i] ** 2), (rr += r[i] ** 2);
  return ll < 1e-9 || rr < 1e-9 ? 1 : lr / Math.sqrt(ll * rr);
}

/** Side over mid, 0 = mono. */
export function width(l: Float32Array, r: Float32Array) {
  let m = 0;
  let s = 0;
  for (let i = 0; i < l.length; i++) (m += (l[i] + r[i]) ** 2), (s += (l[i] - r[i]) ** 2);
  return m < 1e-9 ? 0 : Math.sqrt(s / m);
}

/** A two-pole low-pass, for "mono under this frequency". */
export function lowpass(x: Float32Array, hz: number, sr: number) {
  const out = new Float32Array(x.length);
  const k = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  let a = 0;
  let b = 0;
  for (let i = 0; i < x.length; i++) {
    a += k * (x[i] - a);
    b += k * (a - b);
    out[i] = b;
  }
  return out;
}

export const rmsDb = (x: Float32Array) => {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] ** 2;
  return 10 * Math.log10(e / Math.max(1, x.length) + 1e-12);
};
