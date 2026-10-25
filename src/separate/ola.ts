// HT-Demucs over a whole song (SPEC v0.6 §10, omep-demucs in the browser): the model takes 7.8 s of
// stereo at 44.1 kHz at a time, so the song is cut into segments that overlap by a quarter, each segment's
// stems are weighted by a window that crossfades in the overlaps, and the sum is divided by the weights.
// The first segment doesn't fade in and the last doesn't fade out, so the song's own edges stay at level.
// Pure: the model is a function here (the Worker runs the real one, tests a stand-in).

export const DEMUCS = { sampleRate: 44100, segment: 343980, sources: ['drums', 'bass', 'other', 'vocals'] as const };
export type Stem = (typeof DEMUCS.sources)[number];

/** Where each segment starts and ends (end exclusive, never past total). */
export function segments(total: number, segment = DEMUCS.segment, overlap = Math.floor(segment / 4)) {
  const stride = segment - overlap;
  const n = Math.max(1, Math.ceil(Math.max(0, total - overlap) / stride));
  return Array.from({ length: n }, (_, i) => ({ start: i * stride, end: Math.min(i * stride + segment, total) }));
}

/** The weight of each sample of a segment: linear fades over the overlap, none at the song's edges. */
export function windowFor(length: number, overlap: number, first: boolean, last: boolean): Float32Array {
  const w = new Float32Array(length).fill(1);
  for (let i = 0; i < Math.min(overlap, length); i++) {
    const f = (i + 1) / (overlap + 1);
    if (!first) w[i] = Math.min(w[i], f);
    if (!last) w[length - 1 - i] = Math.min(w[length - 1 - i], f);
  }
  return w;
}

export interface SeparateOptions {
  segment?: number;
  sources?: readonly string[];
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Separate a stereo signal at the model's rate. run gets one segment, planar [L…, R…] of `segment`
 * samples (zero-padded at the end), and answers planar [stem][channel][sample]. The result: per stem,
 * [left, right] of the input's length.
 */
export async function overlapAdd(left: Float32Array, right: Float32Array, run: (segment: Float32Array) => Promise<Float32Array>, o: SeparateOptions = {}): Promise<Float32Array[][]> {
  const N = o.segment ?? DEMUCS.segment;
  const S = (o.sources ?? DEMUCS.sources).length;
  const total = left.length;
  const overlap = Math.floor(N / 4);
  const segs = segments(total, N, overlap);
  const out = Array.from({ length: S }, () => [new Float32Array(total), new Float32Array(total)]);
  const weight = new Float32Array(total);
  for (const [i, s] of segs.entries()) {
    if (o.signal?.aborted) throw new DOMException('Separation cancelled', 'AbortError');
    const len = s.end - s.start;
    const input = new Float32Array(2 * N);
    input.set(left.subarray(s.start, s.end), 0);
    input.set(right.subarray(s.start, s.end), N);
    const stems = await run(input);
    if (stems.length !== S * 2 * N) throw new Error(`The separation model answered ${stems.length} samples, expected ${S * 2 * N}`);
    const w = windowFor(len, overlap, i === 0, i === segs.length - 1);
    for (let k = 0; k < S; k++)
      for (let c = 0; c < 2; c++) {
        const src = stems.subarray((k * 2 + c) * N, (k * 2 + c) * N + len);
        const dst = out[k][c];
        for (let j = 0; j < len; j++) dst[s.start + j] += src[j] * w[j];
      }
    for (let j = 0; j < len; j++) weight[s.start + j] += w[j];
    o.onProgress?.(i + 1, segs.length);
  }
  for (const stem of out)
    for (const ch of stem)
      for (let j = 0; j < total; j++) ch[j] /= Math.max(weight[j], 1e-8);
  return out;
}

/** Linear-interpolation resampling (the page uses OfflineAudioContext when it can; this is the fallback). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.max(1, Math.round((x.length * to) / from));
  const y = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const t = i * r;
    const j = Math.floor(t);
    const f = t - j;
    y[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f;
  }
  return y;
}

/** RMS in dBFS of a few channels together. */
export function rmsDb(channels: Float32Array[]): number {
  let e = 0;
  let n = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) e += c[i] * c[i];
    n += c.length;
  }
  return n ? 10 * Math.log10(e / n + 1e-20) : -200;
}
