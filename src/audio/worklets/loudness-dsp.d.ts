import type { BiquadCoeffs, LiveReading } from '../../analysis/liveLoudness';

export declare class StreamingLoudness {
  constructor(fs: number, kWeighting: BiquadCoeffs[], channels?: number);
  reset(): void;
  push(channels: Float32Array[]): void;
  read(): LiveReading;
}
