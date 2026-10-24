export interface TestParam {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  unit: string;
  step?: number;
}
export declare const TEST_PLUGINS: Record<string, { name: string; vendor: string; kind: 'effect' | 'instrument'; params: TestParam[] }>;
export declare class TestPlugin {
  constructor(id: string, params?: Record<string, number>, channels?: number);
  readonly id: string;
  readonly latency: number;
  params: Record<string, number>;
  setParam(id: string, value: number): void;
  process(inputs: Float32Array[], outputs: Float32Array[]): void;
}
export declare class JitterBuffer {
  constructor(blocks: number);
  readonly blocks: number;
  underruns: number;
  put(n: number, data: Float32Array[]): void;
  next(): { n: number; data: Float32Array[] | null };
}
