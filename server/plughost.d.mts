import { EventEmitter } from 'node:events';
export interface NativePluginInfo {
  format: 'clap';
  id: string;
  name: string;
  vendor: string;
  version: string;
  description: string;
  features: string[];
  kind: 'effect' | 'instrument' | 'note-effect';
  path: string;
}
export interface HostParam {
  id: number;
  name: string;
  module?: string;
  min: number;
  max: number;
  default: number;
  stepped: boolean;
  automatable: boolean;
}
export interface LoadedPlugin {
  ok: true;
  name: string;
  latency: number;
  inputs: number;
  outputs: number;
  params: HostParam[];
}
export function hostBinary(extra?: string[]): string | null;
export function clapDirs(platform?: string, env?: Record<string, string | undefined>, home?: string): string[];
export function findBundles(dirs: string[]): string[];
export function stopScans(): void;
export function scanBundle(host: string, bundle: string, timeoutMs?: number): Promise<NativePluginInfo[]>;
export function scanPlugins(o?: { host?: string | null; dirs?: string[]; cacheFile?: string | null; timeoutMs?: number; retry?: string[] }): Promise<{ plugins: NativePluginInfo[]; failed: { path: string; reason: string }[] }>;
export class PlugHostSession extends EventEmitter {
  constructor(host?: string | null);
  alive: boolean;
  load(o: { path: string; id: string; sampleRate?: number; maxBlock?: number }): Promise<LoadedPlugin>;
  process(seq: number, channels: Float32Array[]): void;
  setParam(id: number, value: number): void;
  getState(): Promise<Buffer>;
  setState(bytes: Uint8Array): Promise<boolean>;
  close(): void;
}
