// Live loudness meters (F20): one AudioWorklet per metered node (the master and each track), each
// reporting momentary / short-term / integrated LUFS and true peak every 100 ms.
import * as Tone from 'tone';
import { kWeighting } from '../analysis/loudness';
import type { LiveReading } from '../analysis/liveLoudness';
import { loudnessWorkletSource } from './worklets/loudness.worklet';

const SILENT: LiveReading = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, truePeak: -Infinity, truePeakMax: -Infinity };
const readings = new Map<string, LiveReading>();
const nodes = new Map<string, AudioWorkletNode>();
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

function load(ctx: BaseAudioContext) {
  let p = loaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([loudnessWorkletSource()], { type: 'application/javascript' })));
    loaded.set(ctx, p);
  }
  return p;
}

/** Meter a node under `key` ('master' or a track id). Silently does nothing where worklets are missing. */
export async function attachMeter(key: string, source: Tone.ToneAudioNode) {
  const ctx = source.context.rawContext as unknown as AudioContext;
  if (!ctx.audioWorklet) return;
  try {
    await load(ctx);
    if (nodes.has(key)) detachMeter(key);
    const node = new AudioWorkletNode(ctx, 'openband-loudness', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', processorOptions: { k: kWeighting(ctx.sampleRate) } });
    node.port.onmessage = (e) => readings.set(key, e.data as LiveReading);
    Tone.connect(source, node);
    nodes.set(key, node);
  } catch (e) {
    console.warn('[openband] loudness meter unavailable:', e);
  }
}

export function detachMeter(key: string) {
  const n = nodes.get(key);
  if (!n) return;
  n.port.onmessage = null;
  n.disconnect();
  nodes.delete(key);
  readings.delete(key);
}

export const readMeter = (key: string): LiveReading => readings.get(key) ?? SILENT;

/** Start the integrated loudness and the true-peak hold again. */
export function resetMeters() {
  for (const n of nodes.values()) n.port.postMessage('reset');
}
