// Time-stretch / pitch-shift off the main thread (F23).
import { processChannel } from '../audio/stretch';

self.onmessage = (ev: MessageEvent<{ id: number; channels: Float32Array[]; factor: number; semitones: number; sampleRate: number }>) => {
  const { id, channels, factor, semitones, sampleRate } = ev.data;
  try {
    const out = channels.map((c) => processChannel(c, factor, semitones, sampleRate));
    (self as unknown as Worker).postMessage({ id, ok: true, channels: out }, out.map((c) => c.buffer));
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (e as Error).message });
  }
};
