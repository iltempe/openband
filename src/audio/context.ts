// Tone.js defaults to a wrapped ("standardized") AudioContext, but Web Audio Modules are native
// AudioWorkletNodes that can only connect to native nodes. Run Tone on a native context instead.
// Imported first by main.tsx, before any Tone node exists.
import * as Tone from 'tone';
import { withListenerParams } from './webAudioCompat';

/** How low a latency to ask the system for (Audio & MIDI): the smallest buffer, or safer ones. */
export const LATENCY_MODES = ['lowest', 'low', 'balanced', 'safe'] as const;
export type LatencyMode = (typeof LATENCY_MODES)[number];
export const LATENCY_KEY = 'openband.latency';
export function latencyMode(): LatencyMode {
  try {
    const m = localStorage.getItem(LATENCY_KEY);
    return (LATENCY_MODES as readonly string[]).includes(m ?? '') ? (m as LatencyMode) : 'low';
  } catch {
    return 'low';
  }
}
// 'lowest' asks for the smallest buffer the device allows (a number: the browser rounds it up).
const HINT: Record<LatencyMode, AudioContextLatencyCategory | number> = { lowest: 0.001, low: 'interactive', balanced: 'balanced', safe: 'playback' };

Tone.setContext(new Tone.Context(withListenerParams(new AudioContext({ latencyHint: HINT[latencyMode()] }))));
