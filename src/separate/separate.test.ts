// Stem separation in the browser (SPEC v0.6 §10) and conformance step 5: the overlap-add around the
// model, isolating a new layer from a full mix, and the model download (only with the user's OK, checked).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { overlapAdd, segments, windowFor } from './ola';
import { isolate, novelty, stemForRole } from './isolate';
import { NeedsDownload, downloadModel, ensureModel, refreshModelStatus, removeModel, setModelSource, sha256Hex, useSeparationModel } from './model';

const SHARES = [0.1, 0.2, 0.3, 0.4];
/** A stand-in for the model: each stem a fixed share of the mix (what the e2e fixture model does too). */
const shareModel = (N: number) => async (seg: Float32Array) => {
  const out = new Float32Array(4 * 2 * N);
  SHARES.forEach((s, k) => {
    for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) out[(k * 2 + c) * N + i] = seg[c * N + i] * s;
  });
  return out;
};
const sine = (f: number, n: number, sr = 44100, a = 0.3) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr));
const corr = (a: Float32Array, b: Float32Array) => {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb + 1e-20);
};

describe('overlap-add around the separation model', () => {
  it('segments cover the song, overlapping by a quarter; the crossfades sum to one', () => {
    const segs = segments(10_000, 1000);
    expect(segs[0]).toEqual({ start: 0, end: 1000 });
    expect(segs.at(-1)!.end).toBe(10_000);
    for (let i = 1; i < segs.length; i++) expect(segs[i - 1].end - segs[i].start).toBe(250);
    const a = windowFor(1000, 250, false, false);
    const b = windowFor(1000, 250, false, false);
    for (let j = 0; j < 250; j++) expect(a[750 + j] + b[j]).toBeCloseTo(1, 6);
    // The song's own edges are not faded.
    expect(windowFor(1000, 250, true, true).every((v) => v === 1)).toBe(true);
    expect(segments(10, 1000)).toEqual([{ start: 0, end: 10 }]);
  });

  it('puts the stems back together exactly where the model is exact, edges included', async () => {
    const N = 1000;
    const left = sine(220, 2600);
    const right = sine(330, 2600);
    const progress: number[] = [];
    const out = await overlapAdd(left, right, shareModel(N), { segment: N, onProgress: (d) => progress.push(d) });
    expect(progress).toEqual([1, 2, 3, 4]);
    SHARES.forEach((s, k) => {
      for (const [c, x] of [left, right].entries()) for (let i = 0; i < x.length; i += 37) expect(out[k][c][i]).toBeCloseTo(x[i] * s, 5);
    });
    // Sums back to the mix: nothing lost at the seams or at the start.
    let worst = 0;
    for (let i = 0; i < left.length; i++) worst = Math.max(worst, Math.abs(out.reduce((a, st) => a + st[0][i], 0) - left[i]));
    expect(worst).toBeLessThan(1e-5);
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController();
    const run = vi.fn(async (seg: Float32Array) => (ac.abort(), shareModel(100)(seg)));
    await expect(overlapAdd(new Float32Array(1000), new Float32Array(1000), run, { segment: 100, signal: ac.signal })).rejects.toThrow(/cancelled/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('conformance step 5: the new part out of a full mix', () => {
  const n = 44100;
  const bass = sine(55, n);
  const keys = sine(660, n, 44100, 0.2);
  const zero = new Float32Array(n);

  it('keeps the stem with new energy, drops what the context already plays', () => {
    // The engine answered context (bass) + the new keys; a little bass leaks into "other" in both.
    const answer = { bass, other: Float32Array.from(keys, (v, i) => v + 0.05 * bass[i]), drums: zero, vocals: zero };
    const context = { bass, other: Float32Array.from(bass, (v) => 0.05 * v), drums: zero, vocals: zero };
    const r = isolate(answer, context);
    expect(r.kept.map((k) => k.stem)).toEqual(['other']);
    expect(r.dropped.map((d) => d.stem)).toEqual(['bass']);
    expect(corr(r.part.subarray(4096, n - 4096), keys.subarray(4096, n - 4096))).toBeGreaterThan(0.98);
    expect(novelty(bass, bass)).toBeLessThan(0.01);
  });

  it('nothing new: nothing kept; the role asked for keeps its stem', () => {
    const same = { bass, other: zero, drums: zero, vocals: zero };
    expect(isolate(same, same).kept).toEqual([]);
    expect(isolate(same, same, 'bass line').kept.map((k) => k.stem)).toEqual(['bass']);
    expect([stemForRole('funk drums'), stemForRole('basso'), stemForRole('voce'), stemForRole('pad')]).toEqual(['drums', 'bass', 'vocals', 'other']);
  });
});

describe('the separation model: downloaded only with the user OK, checked, kept', () => {
  const bytes = new TextEncoder().encode('a stand-in model').buffer as ArrayBuffer;
  beforeEach(async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (k: string) => store.get(k)?.clone(),
        put: async (k: string, r: Response) => void store.set(k, r),
        delete: async (k: string) => store.delete(k),
      }),
    });
    const kv = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) });
    setModelSource({ url: 'https://example.test/model.onnx', sha256: await sha256Hex(bytes), bytes: bytes.byteLength, name: 'stand-in', license: 'MIT', homepage: '' });
  });
  afterEach(() => {
    setModelSource(null);
    vi.unstubAllGlobals();
  });

  it('asks before downloading; downloads, checks and keeps it; removes it', async () => {
    const fetch = vi.fn(async () => new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }));
    vi.stubGlobal('fetch', fetch);
    expect(await refreshModelStatus()).toBe('absent');
    await expect(ensureModel()).rejects.toBeInstanceOf(NeedsDownload);
    expect(fetch).not.toHaveBeenCalled();
    const got = await ensureModel(true);
    expect(new TextDecoder().decode(got)).toBe('a stand-in model');
    expect(useSeparationModel.getState()).toMatchObject({ status: 'ready', received: bytes.byteLength });
    // Kept: no second download.
    await ensureModel();
    expect(fetch).toHaveBeenCalledTimes(1);
    await removeModel();
    expect(await refreshModelStatus()).toBe('absent');
    await expect(ensureModel()).rejects.toBeInstanceOf(NeedsDownload);
  });

  it('a file that does not match its checksum is not used', async () => {
    await expect(downloadModel({ fetch: async () => new Response('tampered') })).rejects.toThrow(/checksum/);
    expect(useSeparationModel.getState().status).toBe('error');
    expect(await refreshModelStatus()).toBe('absent');
  });
});
