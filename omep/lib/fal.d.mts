// Types for fal.mjs (fal.ai models as OMEP engines).
export declare const FAL_QUEUE: string;
export declare const MAX_DATA_URI_BYTES: number;
export interface FalModel {
  id: string;
  endpoint: string;
  name: string;
  homepage?: string;
  license: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  price: { unit: string; usd: number };
  data_policy?: Record<string, unknown>;
  output_rights?: Record<string, unknown>;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}
export declare function manifestFor(model: FalModel, verified: string): Record<string, unknown>;
export declare function scopeSeconds(scp: unknown): number;
export declare function quote(model: FalModel, scp: unknown, request?: Record<string, unknown>): number;
export declare function inputFor(model: FalModel, scp: unknown, request?: Record<string, unknown>, seed?: number): Record<string, unknown>;
export declare function pick(obj: unknown, path: string): unknown;
export declare function outputsOf(model: FalModel, json: unknown): { role: string; url: string }[];
export declare function dataUri(bytes: Uint8Array, mime?: string): string;
export interface FalRequest {
  request_id: string;
  status_url: string;
  response_url: string;
  cancel_url?: string;
}
export declare class FalQueue {
  constructor(o?: { base?: string; key?: string | null; token?: string | null; fetch?: typeof fetch });
  base: string;
  submit(endpoint: string, input: unknown): Promise<FalRequest>;
  status(req: FalRequest): Promise<{ status: string; queue_position?: number; error?: string; error_type?: string }>;
  result(req: FalRequest): Promise<any>;
  cancel(req: FalRequest): Promise<unknown>;
  run(endpoint: string, input: unknown, o?: { signal?: AbortSignal; onStatus?: (s: { status: string }) => void; pollMs?: number; timeoutMs?: number }): Promise<any>;
}
