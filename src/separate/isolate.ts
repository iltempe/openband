// Conformance step 5, isolation (SPEC v0.6 §7): an engine asked for one new layer sometimes answers the
// whole mix — the context it was given plus the new part. OpenBand separates that answer and the context
// into the same stems, keeps the stems where the answer has energy the context doesn't (a spectral
// difference, stem by stem), and from those removes what is still the context (a soft spectral mask).
// What's left is the new part alone, ready to sit on its own track. Pure: STFT in plain TypeScript.

const N = 2048;
const HOP = 512;
const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array, inverse = false) {
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
    const a = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(a);
    const wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

interface Spectrum {
  frames: number;
  re: Float64Array[];
  im: Float64Array[];
}

function stft(x: Float32Array): Spectrum {
  const frames = Math.max(1, Math.ceil(x.length / HOP) + 1);
  const re: Float64Array[] = [];
  const im: Float64Array[] = [];
  for (let f = 0; f < frames; f++) {
    const r = new Float64Array(N);
    const i = new Float64Array(N);
    const at = f * HOP - N / 2;
    for (let k = 0; k < N; k++) {
      const j = at + k;
      if (j >= 0 && j < x.length) r[k] = x[j] * hann[k];
    }
    fft(r, i);
    re.push(r);
    im.push(i);
  }
  return { frames, re, im };
}

function istft(s: Spectrum, length: number): Float32Array {
  const y = new Float64Array(length);
  const w = new Float64Array(length);
  for (let f = 0; f < s.frames; f++) {
    const r = Float64Array.from(s.re[f]);
    const i = Float64Array.from(s.im[f]);
    fft(r, i, true);
    const at = f * HOP - N / 2;
    for (let k = 0; k < N; k++) {
      const j = at + k;
      if (j < 0 || j >= length) continue;
      y[j] += (r[k] / N) * hann[k];
      w[j] += hann[k] * hann[k];
    }
  }
  return Float32Array.from(y, (v, j) => (w[j] > 1e-8 ? v / w[j] : 0));
}

const mag = (s: Spectrum, f: number, k: number) => Math.hypot(s.re[f][k], s.im[f][k]);

/** How much of a stem is new: the share of its spectral energy the context's same stem doesn't explain. */
export function novelty(answer: Float32Array, context: Float32Array | null): number {
  const a = stft(answer);
  if (!context) return 1;
  const c = stft(context);
  let total = 0;
  let extra = 0;
  for (let f = 0; f < a.frames; f++)
    for (let k = 0; k <= N / 2; k++) {
      const m = mag(a, f, k);
      const d = Math.max(0, m - (f < c.frames ? mag(c, f, k) : 0));
      total += m * m;
      extra += d * d;
    }
  return total > 1e-12 ? extra / total : 0;
}

/** The answer's stem without what the context's stem already plays (soft magnitude mask, answer's phase). */
export function subtract(answer: Float32Array, context: Float32Array): Float32Array {
  const a = stft(answer);
  const c = stft(context);
  for (let f = 0; f < a.frames; f++)
    for (let k = 0; k < N; k++) {
      const m = Math.hypot(a.re[f][k], a.im[f][k]);
      if (m < 1e-12) continue;
      const g = Math.max(0, m - (f < c.frames ? Math.hypot(c.re[f][k], c.im[f][k]) : 0)) / m;
      a.re[f][k] *= g;
      a.im[f][k] *= g;
    }
  return istft(a, answer.length);
}

export interface Isolation {
  /** The new part, mono at the stems' rate. */
  part: Float32Array;
  /** Which stems it came from, with their novelty. */
  kept: { stem: string; novelty: number }[];
  dropped: { stem: string; novelty: number }[];
}

/** A stem with at least this share of new energy is (part of) the new layer. */
export const NEW_STEM = 0.35;

/**
 * The new part of an answer, given its stems and the context's stems (same names, same rate, aligned).
 * hint: the role asked for ("bass", "drums", "vocals"…) keeps that stem even when its novelty is low.
 */
export function isolate(answer: Record<string, Float32Array>, context: Record<string, Float32Array> | null, hint?: string): Isolation {
  const length = Math.max(...Object.values(answer).map((x) => x.length));
  const part = new Float32Array(length);
  const kept: Isolation['kept'] = [];
  const dropped: Isolation['dropped'] = [];
  const wanted = hint ? stemForRole(hint) : null;
  for (const [stem, x] of Object.entries(answer)) {
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    if (e / Math.max(1, x.length) < 1e-7) continue; // silent stem (below about −70 dBFS)
    const ctx = context?.[stem] ?? null;
    const n = novelty(x, ctx);
    if (n >= NEW_STEM || stem === wanted) {
      kept.push({ stem, novelty: +n.toFixed(3) });
      const y = ctx ? subtract(x, ctx) : x;
      for (let i = 0; i < y.length; i++) part[i] += y[i];
    } else dropped.push({ stem, novelty: +n.toFixed(3) });
  }
  return { part, kept, dropped };
}

/** Which Demucs stem a role or instrument lives in. */
export function stemForRole(role: string): string {
  const r = role.toLowerCase();
  if (/drum|perc|beat|groove|batter/.test(r)) return 'drums';
  if (/\bbass|basso/.test(r)) return 'bass';
  if (/vocal|voice|voce|sing|choir|coro/.test(r)) return 'vocals';
  return 'other';
}
