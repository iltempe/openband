export declare class TruePeakLimiter {
  constructor(fs: number, o?: { channels?: number; lookaheadMs?: number; ceilingDb?: number; releaseMs?: number; inputGainDb?: number; on?: boolean });
  readonly latency: number;
  readonly reductionDb: number;
  set(o: { ceilingDb?: number; releaseMs?: number; inputGainDb?: number; on?: boolean }): void;
  process(input: Float32Array[], output: Float32Array[], key?: Float32Array[] | null): void;
}
export declare class Compressor {
  constructor(fs: number);
  readonly grDb: number;
  set(o: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number; amount?: number }): void;
  reduction(db: number): number;
  process(signal: Float32Array[], key: Float32Array[] | null, output: Float32Array[]): void;
}
export declare class SidechainDucker extends Compressor {
  constructor(fs: number);
}
