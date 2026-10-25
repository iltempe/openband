// Stem separation in the browser (omep-demucs, SPEC v0.6 §10): HT-Demucs in a Worker, the song cut into
// overlapping segments (ola.ts). Free, private (nothing leaves the computer), works offline once the model
// is downloaded. Answers four stems at 44.1 kHz.
import { DEMUCS, overlapAdd, resample, type Stem } from './ola';
import { ensureModel } from './model';

let worker: Worker | null = null;
let ready: Promise<Worker> | null = null;
let nextId = 1;
/** The worker holds about 1 GB while the model is loaded: it goes after a minute without work. */
const IDLE_MS = 60_000;
let idle: ReturnType<typeof setTimeout> | undefined;
const waiting = new Map<number, { resolve: (f: Float32Array) => void; reject: (e: Error) => void }>();

function start(model: ArrayBuffer): Promise<Worker> {
  ready ??= new Promise<Worker>((resolve, reject) => {
    const w = new Worker(new URL('./demucs.worker.ts', import.meta.url), { type: 'module', name: 'openband-demucs' });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'loaded') return resolve((worker = w));
      if (m.type === 'stems') waiting.get(m.id)?.resolve(m.stems);
      if (m.type === 'error') {
        if (m.id === -1) {
          ready = null;
          w.terminate();
          return reject(new Error(`The separation model could not start: ${m.message}`));
        }
        waiting.get(m.id)?.reject(new Error(`Separation failed: ${m.message}`));
      }
      waiting.delete(m.id);
    };
    w.onerror = (e) => {
      ready = null;
      reject(new Error(`The separation worker failed: ${e.message}`));
    };
    w.postMessage({ type: 'load', model }, [model]);
  });
  return ready;
}

/** Stop the worker (frees the model's memory, about 1 GB while it runs). */
export function stopSeparation() {
  worker?.terminate();
  worker = null;
  ready = null;
  for (const w of waiting.values()) w.reject(new DOMException('Separation cancelled', 'AbortError') as unknown as Error);
  waiting.clear();
}

function runSegment(w: Worker, mix: Float32Array): Promise<Float32Array> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ type: 'run', id, segment: DEMUCS.segment, mix }, [mix.buffer]);
  });
}

/** Resample a channel to 44.1 kHz with the browser's resampler when there is one. */
async function to44k(ch: Float32Array, sr: number): Promise<Float32Array> {
  if (sr === DEMUCS.sampleRate) return ch;
  if (typeof OfflineAudioContext === 'undefined') return resample(ch, sr, DEMUCS.sampleRate);
  const len = Math.max(1, Math.round((ch.length * DEMUCS.sampleRate) / sr));
  const ctx = new OfflineAudioContext(1, len, DEMUCS.sampleRate);
  const b = ctx.createBuffer(1, ch.length, sr);
  b.copyToChannel(ch, 0);
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.connect(ctx.destination);
  s.start();
  return (await ctx.startRendering()).getChannelData(0);
}

export interface Separated {
  sampleRate: number;
  stems: Record<Stem, [Float32Array, Float32Array]>;
}

/** Separate a stereo (or mono: right = left) signal into drums, bass, other and vocals. */
export async function separateInBrowser(left: Float32Array, right: Float32Array | null, sampleRate: number, o: { confirmDownload?: boolean; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<Separated> {
  clearTimeout(idle);
  const w = ready ? await ready : await start(await ensureModel(o.confirmDownload));
  const l = await to44k(left, sampleRate);
  const r = right ? await to44k(right, sampleRate) : l;
  const onAbort = () => stopSeparation();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const out = await overlapAdd(l, r, (seg) => runSegment(w, seg), { onProgress: o.onProgress, signal: o.signal });
    return { sampleRate: DEMUCS.sampleRate, stems: Object.fromEntries(DEMUCS.sources.map((s, i) => [s, out[i] as [Float32Array, Float32Array]])) as Separated['stems'] };
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    idle = setTimeout(stopSeparation, IDLE_MS);
  }
}
