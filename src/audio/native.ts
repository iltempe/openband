// Native plugins in the Web Audio graph (G8): NativePluginNode is an AudioWorklet that exchanges
// 128-frame blocks with a plugin host through a jitter buffer, and reports its latency so the engine can
// compensate it (PDC). In the desktop app the host is openband-plughost (CLAP, VST3, AU), reached over a
// MessagePort straight from the main process; everywhere, the in-process test plugins of native-dsp.js
// run behind the same bridge — and inline, in the worklet, for offline renders.
import * as Tone from 'tone';
import { create } from 'zustand';
import type { CustomInstrument, PluginSlot } from '../types';
import { cutoffToHz } from '../music';
import { nativeWorkletSource } from './worklets/native.worklet';
import { TEST_PLUGINS, TestPlugin } from './worklets/native-dsp.js';

/** Blocks in the jitter buffer of a live bridge: ~16 ms at 48 kHz (the ADR's measurements). */
export const JITTER_BLOCKS = 6;
/** Blocks per batch when an export renders native plugins (the render pauses after each batch). */
export const OFFLINE_BLOCKS = 8;
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
  format: 'clap' | 'vst3' | 'au';
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
  gui: boolean;
  params: (HostParam & { value: number })[];
}
/** What the plugin's own window reports (desktop app). */
interface HostEvent {
  key: string;
  type: 'param' | 'gesture' | 'dirty' | 'gui';
  id?: number;
  value?: number;
  begin?: boolean;
  open?: boolean;
}
interface DesktopNative {
  info(): Promise<{ available: boolean }>;
  scan(o?: { retry?: string[] }): Promise<{ plugins: NativePluginInfo[]; failed: { path: string; reason: string }[]; available: boolean }>;
  open(o: { key: string; path: string; id: string; sampleRate: number; maxBlock: number; state?: string; offline?: boolean }): Promise<LoadedInfo>;
  batch(o: { key: string; blocks: { n: number; data: Float32Array[]; events?: unknown[] }[] }): Promise<{ n: number; data: Float32Array[] }[]>;
  restart(o: { key: string; state?: string }): Promise<LoadedInfo>;
  close(o: { key: string }): Promise<void>;
  state(o: { key: string }): Promise<string | null>;
  addDir(dir: string): Promise<string[]>;
  onCrashed(cb: (e: { key: string; name: string; reason: string }) => void): void;
  setState(o: { key: string; state: string }): Promise<boolean>;
  gui(o: { key: string; open: boolean; title?: string }): Promise<{ open: boolean; supported?: boolean; error?: string }>;
  values(o: { key: string }): Promise<{ id: number; value: number }[]>;
  onEvent(cb: (e: HostEvent) => void): void;
}

/** Event kinds inside a block (as openband-plughost reads them). */
export const NOTE_ON = 0;
export const NOTE_OFF = 1;
export const PARAM = 2;
export const ALL_NOTES_OFF = 3;

/**
 * What the rest of the studio wants to know about native plugins, set by plugins.ts and autoWrite.ts
 * (no imports from here into them: they import this module).
 */
export const nativeHooks: {
  /** The plugin's state changed in its window: record it (one undo step). */
  onDirty?: (key: string, name: string, stateB64: string) => void;
  /** A parameter moved in the plugin's window; gesture = a control grabbed (true) or let go (false). */
  onParam?: (key: string, id: number, value: number, gesture?: boolean) => void;
} = {};
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
export const useNativeStatus = create<Record<string, { crashed?: string; error?: string; latency?: number; gui?: boolean }>>(() => ({}));
const setStatus = (key: string | undefined, v: { crashed?: string; error?: string; latency?: number; gui?: boolean }) => key && useNativeStatus.setState((s) => ({ ...s, [key]: v }));
/** Live native effects by trackId:slotId, for Restart. */
const liveNatives = new Map<string, NativeEffect>();
/** The same plugins by the key of their host process, for its events. */
const byHost = new Map<string, NativeEffect>();
let listening = false;
function listen() {
  const dn = desktopNative();
  if (listening || !dn?.onEvent) return;
  listening = true;
  dn.onEvent((e) => byHost.get(e.key)?.hostEvent(e));
}
/** A live native plugin by trackId:slotId (slotId "instrument" for the track's instrument). */
export const liveNative = (key: string) => liveNatives.get(key) ?? null;
export const allLiveNatives = () => liveNatives;
export const restartNative = (key: string) => liveNatives.get(key)?.restart() ?? Promise.reject(new Error('This plugin is not running'));
/** Set a parameter of a live native plugin (its host id), at the start of its next block. */
export const nativeParam = (key: string, id: number, value: number) => liveNatives.get(key)?.setParam(id, value);

export class NativeEffect {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  ready: Promise<void>;
  /** Samples between what goes in and what comes out (jitter buffer + the plugin's own). */
  latency = 0;
  error: string | null = null;
  /** Blocks the host didn't return in time (live). */
  underruns = 0;
  params: (HostParam & { value: number })[] = [];
  /** Current parameter values, as the host last reported them (window moves included). */
  values = new Map<number, number>();
  /** Has the plugin a window of its own? */
  hasGui = false;
  private node: AudioWorkletNode | null = null;
  private bypassed = false;
  private hostKey: string | null = null;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Exports: blocks from the worklet waiting for the next batch, and the last one received. */
  private offlineQueue: { n: number; data: Float32Array[]; events: unknown[] }[] = [];
  private lastBlock = -1;
  private acks = new Map<number, () => void>();
  /** Rendering an export (an offline context) through the host. */
  offline = false;
  private listeners = new Set<() => void>();

  /** key: trackId:slotId, for the studio's status and Restart. instrument: no audio input (a synth). */
  constructor(readonly slot: PluginSlot, private key?: string, private opts: { instrument?: boolean } = {}) {
    if (!opts.instrument) this.input.connect(this.output);
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
        // Exports (G8.4): a host of its own in the plugin's offline mode; the render pauses every
        // OFFLINE_BLOCKS blocks and flushOffline() sends them through it before going on.
        const key = `nat_off_${Math.random().toString(36).slice(2, 10)}`;
        this.hostKey = key;
        const port = portFor(key);
        const info = await dn.open({ key, path: this.slot.native?.path_hint ?? '', id: this.slot.native!.id, sampleRate: raw.sampleRate, maxBlock: BLOCK, state: this.slot.native?.state_b64, offline: true });
        void port.then((p) => p.close());
        this.params = info.params;
        for (const p of info.params) this.values.set(p.id, p.value);
        const node = new AudioWorkletNode(raw, 'openband-native', { ...opts, processorOptions: { mode: 'port', jitterBlocks: OFFLINE_BLOCKS } });
        node.port.onmessage = (e) => {
          const m = e.data as { type: string; n: number; data: Float32Array[]; events: unknown[] };
          if (m.type === 'block') {
            this.offlineQueue.push(m);
            this.lastBlock = Math.max(this.lastBlock, m.n);
          } else if (m.type === 'ack') this.acks.get(m.n)?.();
        };
        this.node = node;
        this.offline = true;
        this.latency = OFFLINE_BLOCKS * BLOCK + info.latency;
        this.route();
        return;
      }
      const key = `nat_${Math.random().toString(36).slice(2, 10)}`;
      this.hostKey = key;
      const port = portFor(key);
      listen();
      byHost.set(key, this);
      const info = await dn.open({ key, path: this.slot.native?.path_hint ?? '', id: this.slot.native!.id, sampleRate: raw.sampleRate, maxBlock: BLOCK, state: this.slot.native?.state_b64 });
      this.params = info.params;
      this.hasGui = !!info.gui;
      for (const p of info.params) this.values.set(p.id, p.value);
      const node = new AudioWorkletNode(raw, 'openband-native', { ...opts, processorOptions: { mode: 'port', jitterBlocks: JITTER_BLOCKS } });
      node.port.onmessage = (e) => this.fromWorklet(e.data);
      // A processor that throws stops for good: say so instead of going silent.
      node.onprocessorerror = (e) => {
        this.error = `${this.slot.name}: the audio bridge stopped (${(e as ErrorEvent).message ?? 'processor error'})`;
        setStatus(this.key, { error: this.error });
      };
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

  /** From the host: the plugin's window moved a control, grabbed one, changed its state, closed. */
  hostEvent(e: HostEvent) {
    if (e.type === 'param' && e.id !== undefined && e.value !== undefined) {
      this.values.set(e.id, e.value);
      this.changed();
      if (this.key) nativeHooks.onParam?.(this.key, e.id, e.value);
    } else if (e.type === 'gesture' && e.id !== undefined) {
      if (this.key) nativeHooks.onParam?.(this.key, e.id, this.values.get(e.id) ?? 0, !!e.begin);
    } else if (e.type === 'dirty') {
      // Settle first: a knob turned sends many; one undo step when it stops.
      if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
      this.dirtyTimer = setTimeout(() => void this.captureState(), 400);
    } else if (e.type === 'gui') setStatus(this.key, { ...(useNativeStatus.getState()[this.key ?? ''] ?? {}), gui: !!e.open });
  }

  private async captureState() {
    const b64 = await this.getState().catch(() => null);
    if (b64 && this.key) nativeHooks.onDirty?.(this.key, this.slot.name, b64);
  }

  /** The plugin's state (its format's own chunk), base64. */
  async getState(): Promise<string | null> {
    const dn = desktopNative();
    if (!dn || !this.hostKey) return this.slot.native?.state_b64 ?? null;
    return dn.state({ key: this.hostKey });
  }

  async setState(b64: string) {
    const dn = desktopNative();
    if (dn && this.hostKey) await dn.setState({ key: this.hostKey, state: b64 });
  }

  /** Open (or close) the plugin's own window, floating above the studio. */
  async gui(open: boolean) {
    const dn = desktopNative();
    if (!dn || !this.hostKey) return { open: false, supported: false };
    const r = await dn.gui({ key: this.hostKey, open, title: this.slot.name });
    setStatus(this.key, { ...(useNativeStatus.getState()[this.key ?? ''] ?? {}), gui: r.open });
    return r;
  }

  /** Read every value again from the plugin. */
  async refreshValues() {
    const dn = desktopNative();
    if (!dn || !this.hostKey) return;
    for (const v of await dn.values({ key: this.hostKey })) this.values.set(v.id, v.value);
    this.changed();
  }

  /** Subscribe to value changes (UI). */
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** A note or a parameter change at an audio time: the worklet puts it on its sample. */
  event(kind: number, o: { key?: number; id?: number; value?: number; time?: number } = {}) {
    this.node?.port.postMessage({ type: 'event', kind, key: o.key ?? 0, id: o.id ?? 0, value: o.value ?? 0, time: o.time ?? this.input.context.currentTime });
  }

  /** A parameter at an audio time (automation, sample-accurate). */
  setParamAt(id: number, value: number, time?: number) {
    this.values.set(id, value);
    this.event(PARAM, { id, value, time });
  }

  /**
   * Exports: send the blocks rendered so far (up to block `upTo`) through the host and hand the results to
   * the worklet, which acknowledges them — the render goes on only then, so the result is the same every
   * time.
   */
  async flushOffline(upTo: number) {
    const dn = desktopNative();
    if (!this.offline || !dn || !this.hostKey || !this.node) return;
    const t0 = Date.now();
    while (this.lastBlock < upTo - 1 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 0));
    const batch = this.offlineQueue.filter((b) => b.n < upTo);
    this.offlineQueue = this.offlineQueue.filter((b) => b.n >= upTo);
    if (!batch.length) return;
    const out = await dn.batch({ key: this.hostKey, blocks: batch });
    const last = out[out.length - 1].n;
    const acked = new Promise<void>((r) => this.acks.set(last, r));
    for (const o of out) this.node.port.postMessage({ type: 'block', n: o.n, data: o.data, ack: o.n === last });
    await acked;
    this.acks.delete(last);
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
    this.values.set(id, value);
    this.node?.port.postMessage({ type: 'param', id, value });
    this.changed();
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
      if (!this.opts.instrument) this.input.connect(this.output);
      return;
    }
    this.node.disconnect();
    if (!this.opts.instrument) Tone.connect(this.input, this.node);
    Tone.connect(this.node, this.output);
  }

  dispose() {
    if (this.key && liveNatives.get(this.key) === this) liveNatives.delete(this.key);
    if (this.hostKey) {
      byHost.delete(this.hostKey);
      void desktopNative()?.close({ key: this.hostKey });
    }
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.node?.port.close();
    this.node?.disconnect();
    this.input.dispose();
    this.output.dispose();
  }
}

/**
 * A native instrument (G8.3): notes go to the plugin at their audio time, placed on their sample inside
 * the block; its output passes the track's tone filter like the other instruments.
 */
export class NativeInstrument {
  readonly output = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12, Q: 0.5 });
  readonly fx: NativeEffect;
  ready: Promise<void>;
  private held = new Set<number>();

  constructor(custom: CustomInstrument, key?: string) {
    this.fx = new NativeEffect({ id: 'instrument', url: '', name: custom.name, on: true, format: custom.format, native: custom.native }, key, { instrument: true });
    this.fx.output.connect(this.output);
    this.ready = this.fx.ready;
  }

  /** Samples between a note's time and its sound: compensated like an effect's. */
  get latency() {
    return this.fx.activeLatency;
  }
  get error() {
    return this.fx.error;
  }
  private now() {
    return this.output.context.currentTime;
  }
  trigger(pitch: number, duration: number, time: number, velocity: number) {
    this.fx.event(NOTE_ON, { key: pitch, value: velocity, time });
    this.fx.event(NOTE_OFF, { key: pitch, time: time + Math.max(0.02, duration) });
  }
  noteOn(pitch: number, velocity: number, time?: number) {
    this.held.add(pitch);
    this.fx.event(NOTE_ON, { key: pitch, value: velocity, time: time ?? this.now() });
  }
  noteOff(pitch: number, time?: number) {
    this.held.delete(pitch);
    this.fx.event(NOTE_OFF, { key: pitch, time: time ?? this.now() });
  }
  setCutoff(v: number, time?: number) {
    this.output.frequency.rampTo(cutoffToHz(v), 0.05, time);
  }
  releaseAll() {
    this.held.clear();
    this.fx.event(ALL_NOTES_OFF, { time: this.now() });
  }
  dispose() {
    this.fx.dispose();
    this.output.dispose();
  }
}
