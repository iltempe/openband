// Native plugins in the Web Audio graph (G8): NativePluginNode is an AudioWorklet that exchanges
// 128-frame blocks with a plugin host through a jitter buffer, and reports its latency so the engine can
// compensate it (PDC). Until the native host (openband-plughost) runs, the host is in-process: the test
// plugins of native-dsp.js, processed on the page behind the same bridge — and inline, in the worklet,
// for offline renders, where the page can't keep pace with a render faster than real time.
import * as Tone from 'tone';
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

export class NativeEffect {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  ready: Promise<void>;
  /** Samples between what goes in and what comes out (jitter buffer + the plugin's own). */
  latency = 0;
  error: string | null = null;
  /** Blocks the host didn't return in time (live). */
  underruns = 0;
  private node: AudioWorkletNode | null = null;
  private bypassed = false;

  constructor(readonly slot: PluginSlot) {
    this.input.connect(this.output);
    this.ready = this.load().catch((e) => {
      this.error = (e as Error).message;
      console.warn('[openband] native plugin failed to load:', slot.name, e);
    });
  }

  private async load() {
    const raw = this.input.context.rawContext as unknown as BaseAudioContext;
    if (this.slot.format !== 'test') throw new Error(`${this.slot.name}: ${this.slot.format?.toUpperCase()} plugins need the OpenBand desktop app with its plugin host`);
    if (!(await loadNativeWorklet(raw))) throw new Error('AudioWorklets are not available');
    const id = this.slot.native!.id;
    const params = testParams(this.slot);
    const offline = typeof OfflineAudioContext !== 'undefined' && raw instanceof OfflineAudioContext;
    const opts = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' as const };
    const plugin = new TestPlugin(id, params);
    if (offline) {
      this.node = new AudioWorkletNode(raw, 'openband-native', { ...opts, processorOptions: { mode: 'inline', plugin: { id, params } } });
      this.latency = plugin.latency;
    } else {
      // The in-process host: blocks come here and go back, as they will to openband-plughost.
      const node = new AudioWorkletNode(raw, 'openband-native', { ...opts, processorOptions: { mode: 'port', jitterBlocks: JITTER_BLOCKS } });
      node.port.onmessage = (e) => {
        const m = e.data as { type: string; n: number; data: Float32Array[]; underruns: number };
        if (m.type === 'stats') this.underruns = m.underruns;
        if (m.type !== 'block') return;
        const out = m.data.map((c) => new Float32Array(c.length));
        plugin.process(m.data, out);
        node.port.postMessage({ type: 'block', n: m.n, data: out }, out.map((b) => b.buffer));
      };
      this.node = node;
      this.latency = JITTER_BLOCKS * BLOCK + plugin.latency;
    }
    this.route();
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
    this.node?.port.close();
    this.node?.disconnect();
    this.input.dispose();
    this.output.dispose();
  }
}
