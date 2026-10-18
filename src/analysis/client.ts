// Main-thread side of the analysis worker: render audio, ship channels (transferred), await results.
import type { AnalysisInput } from './analyze';
import type { KeyResult } from './key';
import type { SpectrogramRequest } from '../workers/analysis.worker';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
  }
  return worker;
}

function run<T>(msg: Record<string, unknown>, transfer: Transferable[]): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, ...msg }, transfer);
  });
}

/** Copies of the buffer's channels (the AudioBuffer may be cached, so its data isn't transferred). */
export const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice());

export const analyzeInWorker = (input: AnalysisInput) =>
  run<Record<string, unknown>>({ type: 'analyze', input }, [...input.mix, ...(input.stems ?? []).flatMap((s) => s.channels)].map((c) => c.buffer));

export const spectrogramInWorker = (req: SpectrogramRequest) => run<string>({ type: 'spectrogram', req }, req.channels.map((c) => c.buffer));

export const pitchTrackInWorker = (channels: Float32Array[], sampleRate: number) =>
  run<import('./pitchtrack').TrackedNote[]>({ type: 'pitchtrack', channels, sampleRate }, channels.map((c) => c.buffer));

export const audioKeyInWorker = (channels: Float32Array[], sampleRate: number) => run<KeyResult | null>({ type: 'audioKey', channels, sampleRate }, channels.map((c) => c.buffer));
