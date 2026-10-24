// Native plugins in the Web Audio graph (G8): NativePluginNode is an AudioWorklet that exchanges
// 128-frame blocks with a plugin host through a jitter buffer, and reports its latency so the engine can
// compensate it (PDC). In the desktop app the host is openband-plughost (CLAP), reached over a
// MessagePort straight from the main process; everywhere, the in-process test plugins of native-dsp.js
// run behind the same bridge — and inline, in the worklet, for offline renders.
import * as Tone from 'tone';
import { create } from 'zustand';
import type { PluginSlot } from '../types';
import { nativeWorkletSource } from './worklets/native.worklet';
import { TEST_PLUGINS, TestPlugin } from './worklets/native-dsp.js';

/** Blocks in the jitter buffer of a live bridge: ~16 ms at 48 kHz (the ADR's measurements). */
export const JITTER_BLOCKS = 6;
/** Longest plugin latency the engine and the render compensate (seconds). */
export const MAX_PDC_SECONDS = 1;
export const BLOCK = 128;

const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();
function loadNativeWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = loaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet
      ? ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([nativeWorkletSource()], { type: 'application/javascript' }))).then(
          () => true,
          () => false,
        )
      : Promise.resolve(false);
    loaded.set(ctx, p);
  }
  return p;
}

/** Test-plugin parameters kept in the slot (native.state_b64: base64 of their JSON). */
export function testParams(slot: PluginSlot): Record<string, number> {
  try {
    return slot.native?.state_b64 ? (JSON.parse(atob(slot.native.state_b64)) as Record<string, number>) : {};
  } catch {
    return {};
  }
}
export const encodeTestParams = (params: Record<string, number>) => btoa(JSON.stringify(params));

/** A slot for one of the in-process test plugins. */
export function testSlot(id: string, pluginId: string, params: Record<string, number> = {}): PluginSlot {
  const def = TEST_PLUGINS[pluginId];
  if (!def) throw new Error(`Unknown test plugin "${pluginId}". Test plugins: ${Object.keys(TEST_PLUGINS).join(', ')}`);
  return { id, url: '', name: def.name, on: true, format: 'test', native: { id: pluginId, vendor: def.vendor, version: '1.0.0', state_b64: encodeTestParams(params) } };
}

/** The desktop app's native plugin bridge (preload), when there is one. */
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
  min: number;
  max: number;
  default: number;
  stepped: boolean;
  automatable: boolean;
}
interface LoadedInfo {
  name: string;
  latency: number;
  params: HostParam[];
}
interface DesktopNative {
  info(): Promise<{ available: boolean }>;
  scan(o?: { retry?: string[] }): Promise<{ plugins: NativePluginInfo[]; failed: { path: string; reason: string }[]; available: boolean }>;
  open(o: { key: string; path: string; id: string; sampleRate: number; maxBlock: number; state?: string }): Promise<LoadedInfo>;
  restart(o: { key: string; state?: string }): Promise<LoadedInfo>;
  close(o: { key: string }): Promise<void>;
  state(o: { key: string }): Promise<string | null>;
  addDir(dir: string): Promise<string[]>;
  onCrashed(cb: (e: { key: string; name: string; reason: string }) => void): void;
}
export const desktopNative = (): DesktopNative | null => (typeof window !== 'undefined' ? ((window as unknown as { openbandDesktop?: { native?: DesktopNative } }).openbandDesktop?.native ?? null) : null);

// The audio port of each opened plugin arrives as a window message (see desktop/preload.cjs).
const ports = new Map<string, MessagePort>();
const portWaiters = new Map<string, (p: MessagePort) => void>();
if (typeof window !== 'undefined')
  window.addEventListener('message', (e) => {
    const key = (e.data as { openbandNativePort?: string })?.openbandNativePort;
    if (e.source !== window || !key || !e.ports[0]) return;
    const w = portWaiters.get(key);
    if (w) {
      portWaiters.delete(key);
      w(e.ports[0]);
    } else ports.set(key, e.ports[0]);
  });
const portFor = (key: string) =>
  new Promise<MessagePort>((resolve) => {
    const p = ports.get(key);
    if (p) {
      ports.delete(key);
      resolve(p);
    } else portWaiters.set(key, resolve);
  });

/** What the studio shows about each native plugin slot (trackId:slotId). */
export const useNativeStatus = create<Record<string, { crashed?: string; error?: string; latency?: number }>>(() => ({}));
const setStatus = (key: string | undefined, v: { crashed?: string; error?: string; latency?: number }) => key && useNativeStatus.setState((s) => ({ ...s, [key]: v }));
/** Live native effects by trackId:slotId, for Restart. */
const liveNatives = new Map<string, NativeEffect>();
export const restartNative = (key: string) => liveNatives.get(key)?.restart() ?? Promise.reject(new Error('This plugin is not running'));
/** Set a parameter of a live native plugin (its host id), at the start of its next block. */
export const nativeParam = (key: string, id: number, value: number) => liveNatives.get(key)?.setParam(id, value);

let lastOfflineNotice = 0;

export class NativeEffect {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  ready: Promise<void>;
  /** Samples between what goes in and what comes out (jitter buffer + the plugin's own). */
  latency = 0;
  error: string | null = null;
  /** Blocks the host didn't return in time (live). */
  underruns = 0;
  params: HostParam[] = [];
  private node: AudioWorkletNode | null = null;
  private bypassed = false;
  private hostKey: string | null = null;

  /** key: trackId:slotId, for the studio's status and Restart. */
  constructor(readonly slot: PluginSlot, private key?: string) {
    this.input.connect(this.output);
    if (key) liveNatives.set(key, this);
    this.ready = this.load().catch((e) => {
      this.error = (e as Error).message;
      setStatus(this.key, { error: this.error });
      console.warn('[openband] native plugin failed to load:', slot.name, e);
    });
  }

  private async load() {
    const raw = this.input.context.rawContext as unknown as BaseAudioContext;
    if (!(await loadNativeWorklet(raw))) throw new Error('AudioWorklets are not available');
    const offline = typeof OfflineAudioContext !== 'undefined' && raw instanceof OfflineAudioContext;
    const opts = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' as const };
    if (this.slot.format !== 'test') {
      const dn = desktopNative();
      if (!dn) throw new Error(`${this.slot.name}: ${this.slot.format?.toUpperCase()} plugins need the OpenBand desktop app`);
      if (offline) {
        // Rendering native plugins offline (freezing them) comes in G8.4: until then exports play the track without it.
        if (Date.now() - lastOfflineNotice > 60000) {
          lastOfflineNotice = Date.now();
          const { useStore } = await import('../store');
          useStore.getState().notify(`${this.slot.name} is heard live but not in exports yet: native plugins are exported from the next update`);
        }
        return;
      }
      const key = `nat_${Math.random().toString(36).slice(2, 10)}`;
      this.hostKey = key;
      const port = portFor(key);
      const info = await dn.open({ key, path: this.slot.native?.path_hint ?? '', id: this.slot.native!.id, sampleRate: raw.sampleRate, maxBlock: BLOCK, state: this.slot.native?.state_b64 });
      this.params = info.params;
      const node = new AudioWorkletNode(raw, 'openband-native', { ...opts, processorOptions: { mode: 'port', jitterBlocks: JITTER_BLOCKS } });
      node.port.onmessage = (e) => this.fromWorklet(e.data);
      node.port.postMessage({ type: 'transport', pluginLatency: info.latency }, [await port]);
      this.node = node;
      this.latency = JITTER_BLOCKS * BLOCK + info.latency;
      setStatus(this.key, { latency: this.latency });
      this.route();
      return;
    }
    const id = this.slot.native!.id;
    const params = testParams(this.slot);
    const plugin = new TestPlugin(id, params);
    if (offline) {
      this.node = new AudioWorkletNode(raw, 'openband-native', { ...opts, processorOptions: { mode: 'inline', plugin: { id, params } } });
      this.latency = plugin.latency;
    } else {
      // The in-process host: blocks come here and go back, as they do to openband-plughost.
      const node = new AudioWorkletNode(raw, 'openband-native', { ...opts, processorOptions: { mode: 'port', jitterBlocks: JITTER_BLOCKS } });
      node.port.onmessage = (e) => {
        const m = e.data as { type: string; n: number; data: Float32Array[]; underruns: number };
        if (m.type !== 'block') return this.fromWorklet(m);
        const out = m.data.map((c) => new Float32Array(c.length));
        plugin.process(m.data, out);
        node.port.postMessage({ type: 'block', n: m.n, data: out }, out.map((b) => b.buffer));
      };
      this.node = node;
      this.latency = JITTER_BLOCKS * BLOCK + plugin.latency;
    }
    this.route();
  }

  private fromWorklet(m: { type: string; underruns?: number; reason?: string; latency?: number }) {
    if (m.type === 'stats') this.underruns = m.underruns ?? 0;
    // The worklet already plays the track bypassed, as late as before: only the studio needs telling.
    if (m.type === 'crashed') setStatus(this.key, { crashed: `${this.slot.name} ${m.reason ?? 'stopped'}`, latency: this.latency });
  }

  /** Start a crashed plugin again, with the state saved in the song. */
  async restart() {
    const dn = desktopNative();
    if (!dn || !this.hostKey || !this.node) throw new Error('This plugin can only be restarted in the desktop app');
    const port = portFor(this.hostKey);
    const info = await dn.restart({ key: this.hostKey, state: this.slot.native?.state_b64 });
    this.node.port.postMessage({ type: 'transport', pluginLatency: info.latency }, [await port]);
    setStatus(this.key, { latency: this.latency });
  }

  setParam(id: number, value: number) {
    this.node?.port.postMessage({ type: 'param', id, value });
  }

  setBypass(off: boolean) {
    this.bypassed = off;
    this.route();
  }

  /** Latency that counts for compensation: none when bypassed (the signal goes round the plugin). */
  get activeLatency() {
    return this.node && !this.bypassed ? this.latency : 0;
  }

  private route() {
    this.input.disconnect();
    if (!this.node || this.bypassed) {
      this.input.connect(this.output);
      return;
    }
    this.node.disconnect();
    Tone.connect(this.input, this.node);
    Tone.connect(this.node, this.output);
  }

  dispose() {
    if (this.key && liveNatives.get(this.key) === this) liveNatives.delete(this.key);
    if (this.hostKey) void desktopNative()?.close({ key: this.hostKey });
    this.node?.port.close();
    this.node?.disconnect();
    this.input.dispose();
    this.output.dispose();
  }
}
