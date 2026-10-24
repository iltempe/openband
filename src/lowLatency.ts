// Low-latency monitoring (G8.7, desktop app): when the track you play (the selected one) has a native
// instrument, the plugin host opens the computer's audio output itself with a small buffer, and the notes
// of your keyboard go straight to it — you hear only the device's latency, not the web bridge's. The
// rest of the song keeps playing through the studio; the track's timeline notes play on the host's output
// too, delayed by what the bridge takes so they stay in time. The track's fader and pan apply there; its
// other effects (EQ, compressor, web plugins) and the master chain don't, while monitoring is on.
import * as Tone from 'tone';
import { create } from 'zustand';
import { engine } from './audio/engine';
import { BLOCK, JITTER_BLOCKS, desktopNative, useNativeStatus, type MonitorInfo, type NativeInstrument } from './audio/native';
import { useStore } from './store';

/** Frames of the host's output buffer (one period; the device keeps two). */
export const MONITOR_PERIOD = 128;
const PREF = 'openband.lowLatency';

export const useLowLatency = create<{ enabled: boolean; trackId: string | null; info: MonitorInfo | null; error: string | null }>(() => ({
  enabled: readPref(),
  trackId: null,
  info: null,
  error: null,
}));

function readPref() {
  try {
    return localStorage.getItem(PREF) !== '0';
  } catch {
    return true;
  }
}

export function setLowLatency(on: boolean) {
  try {
    localStorage.setItem(PREF, on ? '1' : '0');
  } catch {}
  useLowLatency.setState({ enabled: on });
  void syncMonitoring();
}

/**
 * How late the host plays the timeline's notes: what a block takes through the bridge (the jitter buffer)
 * and the studio's own output, minus the host's buffer.
 */
export function monitorLead(sampleRate: number, outputLatency: number, period = MONITOR_PERIOD) {
  return Math.max(0, JITTER_BLOCKS * BLOCK + Math.round(outputLatency * sampleRate) - 2 * period);
}

let current: { trackId: string; inst: NativeInstrument; mix: string } | null = null;
let chain = Promise.resolve();

/** Turn monitoring on for the selected track's native instrument, off for any other; keep its mix. */
export function syncMonitoring() {
  chain = chain.then(step, step);
  return chain;
}

async function step() {
  if (!desktopNative()?.monitor) return;
  const { enabled } = useLowLatency.getState();
  const id = useStore.getState().selectedTrackId;
  const inst = enabled && id ? engine.nativeInstrument(id) : null;
  if (current && current.inst !== inst) {
    const was = current;
    current = null;
    was.inst.monitoring = false;
    await was.inst.fx.monitor({ on: false }).catch(() => null);
    useLowLatency.setState({ trackId: null, info: null });
  }
  if (!inst || !id) return;
  await inst.ready;
  if (inst.error) return;
  const m = engine.trackMix(id);
  const raw = Tone.getContext().rawContext as AudioContext;
  const lead = monitorLead(raw.sampleRate, raw.outputLatency || raw.baseLatency || 0);
  const mix = `${m.gain.toFixed(4)} ${m.pan.toFixed(3)} ${lead}`;
  if (current?.inst === inst && current.mix === mix) return;
  const r = await inst.fx.monitor({ on: true, period: MONITOR_PERIOD, lead, gain: m.gain, pan: m.pan }).catch((e: Error) => ({ on: false, error: e.message }) as MonitorInfo);
  if (!r.on) {
    inst.monitoring = false;
    useLowLatency.setState({ trackId: null, info: null, error: r.error ?? null });
    return;
  }
  inst.monitoring = true;
  current = { trackId: id, inst, mix };
  useLowLatency.setState({ trackId: id, info: r.backend ? r : (useLowLatency.getState().info ?? r), error: null });
}

let started = false;
/** Follow the selected track, its fader and pan, and the plugins coming up (or back after a crash). */
export function startMonitoring() {
  if (started || !desktopNative()?.monitor) return;
  started = true;
  useStore.subscribe((s, prev) => {
    if (s.selectedTrackId !== prev.selectedTrackId || s.project.tracks !== prev.project.tracks) void syncMonitoring();
  });
  useNativeStatus.subscribe(() => void syncMonitoring());
  void syncMonitoring();
}
