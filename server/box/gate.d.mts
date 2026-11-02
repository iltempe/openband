export class Gate {
  constructor(o?: { sampleRate?: number; channels?: number; preRollS?: number; thresholdDb?: number; startMs?: number; endMs?: number; splitMs?: number });
  push(interleaved: Float32Array): { type: 'start' | 'split' | 'end'; at: number }[];
  force(on: boolean): { type: 'start' | 'split' | 'end'; at: number } | null;
}
