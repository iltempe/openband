export const STREAM_PROTOCOL: string;
export const SAMPLE_RATE: number;
export const FRAME_SAMPLES: number;
export const HEADER_BYTES: number;
export interface StreamFrame { seq: number; beat: number; sampleRate: number; channels: number; epoch: number; frames: number; samples: Float32Array }
export function encodeFrame(f: { seq: number; beat: number; sampleRate?: number; channels?: number; epoch?: number; samples: Float32Array }): Uint8Array;
export function decodeFrame(data: ArrayBuffer | Uint8Array): StreamFrame;
export function frameBeats(frames: number, sampleRate: number, bpm: number): number;
export interface ClockMessage { beat: number; bpm: number; playing: boolean; lead_ms?: number; rtt_ms?: number; epoch?: number }
export class StreamProducer {
  constructor(opts: { now: () => number; sampleRate?: number; frameSamples?: number; leadMs?: number; maxAheadMs?: number });
  leadMs: number;
  playing: boolean;
  seq: number;
  restarts: number;
  next: number | null;
  beatNow(t?: number): number | null;
  clock(msg: ClockMessage, t?: number): { produced_beat: number | null; lead_ms: number };
  due(t?: number): { seq: number; beat: number; frames: number; bpm: number; epoch: number }[];
  epoch: number;
}
