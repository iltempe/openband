export function defaultEnginesFile(): string;
export function readEnginesConfig(file?: string): Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; token?: string }>;
export class EngineHost {
  constructor(o?: { file?: string; log?: (...a: unknown[]) => void });
  live: Map<string, unknown>;
  list(): Promise<{ id: string; status: string; error?: string; manifest?: any }[]>;
  call(id: string, capability: string, args: unknown, o?: { timeoutMs?: number }): Promise<any>;
  drop(id: string): Promise<void>;
  close(): Promise<void>;
}
