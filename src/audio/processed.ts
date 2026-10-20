// Stretched / pitch-shifted versions of audio clips (F23): computed in a worker, cached by
// (sample, factor, semitones), used by the live engine and the offline render alike.
import type { AudioClip } from '../types';
import { getBuffer } from './samples';
import { processChannel, stretchFactor } from './stretch';

const cache = new Map<string, AudioBuffer>();
const inflight = new Map<string, Promise<AudioBuffer | undefined>>();
const listeners = new Set<() => void>();
const CACHE_SIZE = 16;

export const processingOf = (clip: AudioClip, bpm: number) => ({ factor: +stretchFactor(clip, bpm).toFixed(5), semitones: +(clip.pitch ?? 0).toFixed(2) });
export const needsProcessing = (clip: AudioClip, bpm: number) => {
  const { factor, semitones } = processingOf(clip, bpm);
  return Math.abs(factor - 1) > 1e-4 || Math.abs(semitones) > 1e-3;
};
const keyOf = (clip: AudioClip, bpm: number) => {
  const { factor, semitones } = processingOf(clip, bpm);
  return `${clip.sampleId}|${factor}|${semitones}`;
};

/** Called when a processed buffer becomes available (the engine re-schedules its players). */
export const onProcessed = (fn: () => void) => void listeners.add(fn);

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: { ok: boolean; channels?: Float32Array[]; error?: string }) => void>();
function run(channels: Float32Array[], factor: number, semitones: number, sampleRate: number): Promise<Float32Array[]> {
  if (typeof Worker === 'undefined') return Promise.resolve(channels.map((c) => processChannel(c, factor, semitones, sampleRate)));
  if (!worker) {
    worker = new Worker(new URL('../workers/stretch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const p = pending.get(ev.data.id);
      pending.delete(ev.data.id);
      p?.(ev.data);
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (r) => (r.ok ? resolve(r.channels!) : reject(new Error(r.error))));
    worker!.postMessage({ id, channels, factor, semitones, sampleRate }, channels.map((c) => c.buffer));
  });
}

/** The buffer a clip plays from: the original, or its processed version once ready (else undefined). */
export function clipBuffer(clip: AudioClip, bpm: number): AudioBuffer | undefined {
  if (!needsProcessing(clip, bpm)) return getBuffer(clip.sampleId);
  const k = keyOf(clip, bpm);
  const b = cache.get(k);
  if (b) {
    cache.delete(k);
    cache.set(k, b);
  }
  return b;
}

/** Make sure the processed buffer exists (computing it in the worker). */
export function ensureClipBuffer(clip: AudioClip, bpm: number): Promise<AudioBuffer | undefined> {
  const ready = clipBuffer(clip, bpm);
  if (ready) return Promise.resolve(ready);
  const src = getBuffer(clip.sampleId);
  if (!src) return Promise.resolve(undefined);
  const k = keyOf(clip, bpm);
  let job = inflight.get(k);
  if (!job) {
    const { factor, semitones } = processingOf(clip, bpm);
    const channels = Array.from({ length: src.numberOfChannels }, (_, c) => src.getChannelData(c).slice());
    job = run(channels, factor, semitones, src.sampleRate)
      .then((out) => {
        const b = new AudioBuffer({ numberOfChannels: out.length, length: out[0].length, sampleRate: src.sampleRate });
        out.forEach((c, i) => b.copyToChannel(c, i));
        cache.set(k, b);
        while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
        for (const fn of listeners) fn();
        return b;
      })
      .catch((e) => {
        console.warn('[openband] time-stretch failed:', e);
        return undefined;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, job);
  }
  return job;
}
