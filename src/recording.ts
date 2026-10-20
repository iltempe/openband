// Microphone recording (audio clips or "hum a melody") and audio → MIDI conversion.
import * as Tone from 'tone';
import { create } from 'zustand';
import type { Note, Region } from './types';
import { BEATS_PER_BAR, clamp, uid } from './music';
import { getTrack, makeTrack, useStore } from './store';
import { engine } from './audio/engine';
import { encodeMonoWav, getBuffer, importSample } from './audio/samples';
import { addAudioRegion } from './importers';
import { pitchTrackInWorker } from './analysis/client';
import { quantizeNotes, snapToScale } from './analysis/pitchtrack';
import { scalePitchClasses } from './analysis/key';
import { emitStudioEvent } from './events';
import { beginFlubTake, bindPendingFlubs, flushPendingFlubs } from './flubLive';

export type MicMode = 'audio' | 'hum';
export interface MicState {
  state: 'idle' | 'confirm' | 'countin' | 'recording' | 'processing';
  mode: MicMode;
  /** Beats left in the count-in. */
  countdown: number;
  /** Input level 0 … 1 for the meter. */
  level: number;
  /** Extra latency compensation, ms (added to what the browser reports). */
  offsetMs: number;
  /** Instrument for hummed melodies. */
  humInstrument: string;
  /** Pending request from the AI, waiting for the user's OK. */
  request: { bars?: number; startBar: number; mode: MicMode; resolve: (ok: boolean) => void } | null;
  error: string | null;
}

const OFFSET_KEY = 'openband.micOffsetMs';
const initialOffset = () => {
  try {
    return Number(localStorage.getItem(OFFSET_KEY)) || 0;
  } catch {
    return 0;
  }
};

export const useMic = create<MicState>(() => ({ state: 'idle', mode: 'audio', countdown: 0, level: 0, offsetMs: initialOffset(), humInstrument: 'felt-piano', request: null, error: null }));
export function setMicOffset(ms: number) {
  useMic.setState({ offsetMs: ms });
  try {
    localStorage.setItem(OFFSET_KEY, String(ms));
  } catch {
    // not persisted
  }
}

// The worklet just forwards input blocks (2048 frames) with their audio time.
const WORKLET = `
class OpenBandRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.t = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n === 0) this.t = currentTime;
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n >= this.buf.length) { this.port.postMessage({ t: this.t, d: this.buf }); this.buf = new Float32Array(2048); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('openband-recorder', OpenBandRecorder);`;

let session: { stop: () => void } | null = null;
const loaded = new WeakSet<BaseAudioContext>();

export interface RecordOptions {
  mode: MicMode;
  trackId?: string;
  startBeat?: number;
  /** Stop automatically after this many bars (otherwise when the user stops). */
  bars?: number;
}

export interface RecordResult {
  region_id: string;
  track_id: string;
  seconds: number;
  midi?: { region_id: string; track_id: string; notes: number };
}

/** Record from the microphone with a one-bar count-in. Resolves when the take is stored. */
export async function recordFromMic(o: RecordOptions): Promise<RecordResult> {
  if (session) throw new Error('Already recording');
  const st = useStore.getState();
  const p = st.project;
  const startBeat = Math.max(0, o.startBeat ?? Math.floor(engine.position / BEATS_PER_BAR) * BEATS_PER_BAR);
  const ctx = Tone.getContext().rawContext as unknown as AudioContext;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).catch((e) => {
    throw new Error(`Microphone not available: ${(e as Error).message}`);
  });
  if (!loaded.has(ctx)) {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    loaded.add(ctx);
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'openband-recorder');
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink).connect(ctx.destination);
  const chunks: { t: number; d: Float32Array }[] = [];
  node.port.onmessage = (ev) => {
    chunks.push(ev.data);
    let s = 0;
    for (const x of ev.data.d as Float32Array) s += x * x;
    useMic.setState({ level: Math.min(1, Math.sqrt(s / 2048) * 4) });
  };

  // Count-in: one bar of clicks, then the transport starts on startBeat at audio time t0.
  useMic.setState({ state: 'countin', mode: o.mode, error: null });
  if (engine.playing) engine.stop();
  engine.position = startBeat;
  engine.metronomeForced = true;
  let stopped = false;
  session = { stop: () => void (stopped = true) };
  const t0 = await engine.playWithCountIn(BEATS_PER_BAR);
  st.set({ isPlaying: true });
  const endTime = o.bars !== undefined ? t0 + (o.bars * BEATS_PER_BAR * 60) / p.bpm : Infinity;

  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      const now = ctx.currentTime;
      if (now < t0) {
        const left = Math.ceil(((t0 - now) * p.bpm) / 60);
        if (left !== useMic.getState().countdown) useMic.setState({ countdown: left });
      } else if (useMic.getState().state === 'countin') {
        useMic.setState({ state: 'recording', countdown: 0 });
        beginFlubTake({ trackId: o.trackId, pass: () => 0 });
      }
      if (stopped || now >= endTime + 0.05 || (now > t0 + 0.2 && !engine.playing)) {
        clearInterval(tick);
        resolve();
      }
    }, 30);
  });

  engine.stop();
  engine.metronomeForced = false;
  useStore.getState().set({ isPlaying: false });
  stream.getTracks().forEach((t) => t.stop());
  source.disconnect();
  node.disconnect();
  session = null;
  useMic.setState({ state: 'processing', level: 0 });

  try {
    if (!chunks.length) throw new Error('No audio came from the microphone');
    // Sound that reached the speakers at t0 comes back through the mic `latency` later.
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + useMic.getState().offsetMs / 1000;
    const all = new Float32Array(chunks.length * 2048);
    chunks.forEach((c, i) => all.set(c.d, i * 2048));
    const from = Math.max(0, Math.round((t0 + latency - chunks[0].t) * ctx.sampleRate));
    const to = Math.min(all.length, endTime === Infinity ? all.length : Math.round((endTime + latency - chunks[0].t) * ctx.sampleRate));
    const pcm = all.subarray(from, to);
    if (pcm.length < ctx.sampleRate * 0.1) throw new Error('The recording is too short');
    const n = (p.regions.filter((r) => r.audio).length ?? 0) + 1;
    const info = await importSample(encodeMonoWav(pcm, ctx.sampleRate), `Recording ${n}.wav`);
    const track = o.trackId ? getTrack(useStore.getState().project, o.trackId) : undefined;
    const tx = useStore.getState().beginTransaction(o.mode === 'hum' ? 'Hummed melody' : 'Audio recording', 'ui');
    try {
      const region = addAudioRegion(info, { trackId: track?.kind === 'audio' ? track.id : undefined, startBeat });
      useStore.getState().commit((d) => bindPendingFlubs(d, d.regions.find((r) => r.id === region.id)));
      emitStudioEvent({ kind: 'region_recorded', region_id: region.id });
      const result: RecordResult = { region_id: region.id, track_id: region.trackId, seconds: +info.duration.toFixed(2) };
      if (o.mode === 'hum') {
        const midi = await audioRegionToMidi(region.id, { instrument: useMic.getState().humInstrument, snapToKey: true, quantize: 0.25, strength: 0.6 });
        // Keep the hummed audio under the melody for comparison, muted.
        useStore.getState().commit((d) => void (d.tracks.find((t) => t.id === region.trackId)!.mute = true), { history: false });
        result.midi = { region_id: midi.region_id, track_id: midi.track_id, notes: midi.notes.length };
      }
      return result;
    } finally {
      useStore.getState().endTransaction(tx);
    }
  } catch (e) {
    useMic.setState({ error: (e as Error).message });
    throw e;
  } finally {
    // Marks of a take that could not be stored are kept anyway.
    flushPendingFlubs();
    useMic.setState({ state: 'idle' });
  }
}

export const stopMicRecording = () => session?.stop();

/** Ask the user before the AI records (the browser also asks for microphone permission). */
export function requestRecording(mode: MicMode, startBar: number, bars?: number): Promise<boolean> {
  return new Promise((resolve) => useMic.setState({ state: 'confirm', request: { mode, startBar, bars, resolve } }));
}

export interface ToMidiOptions {
  trackId?: string;
  instrument?: string;
  snapToKey?: boolean;
  /** Grid in beats (e.g. 0.25), 0/undefined = no quantize. */
  quantize?: number;
  strength?: number;
}

/** Monophonic audio → MIDI region aligned with the audio region. */
export async function audioRegionToMidi(regionId: string, o: ToMidiOptions = {}) {
  const p = useStore.getState().project;
  const r = p.regions.find((x) => x.id === regionId);
  if (!r?.audio) throw new Error(`Region "${regionId}" is not an audio region`);
  return audioToMidi(r.audio.sampleId, r.start, r.audio.offset, (r.length * 60) / p.bpm, o);
}

export async function audioToMidi(sampleId: string, startBeat: number, offsetSec: number, seconds: number | undefined, o: ToMidiOptions = {}) {
  const buf = getBuffer(sampleId);
  if (!buf) throw new Error(`Sample "${sampleId}" is not loaded`);
  const p = useStore.getState().project;
  const sr = buf.sampleRate;
  const from = Math.floor(offsetSec * sr);
  const to = seconds !== undefined ? Math.min(buf.length, from + Math.ceil(seconds * sr)) : buf.length;
  const ch = buf.getChannelData(0).slice(from, to);
  const tracked = await pitchTrackInWorker([ch], sr);
  if (!tracked.length) throw new Error('No clear pitch found in the audio (is it a single voice or instrument?)');
  const scale = scalePitchClasses(p.key);
  let notes = tracked.map((n) => ({ pitch: clamp(o.snapToKey === false ? n.pitch : snapToScale(n.pitch, scale), 0, 127), start: (n.start * p.bpm) / 60, duration: Math.max(0.0625, (n.duration * p.bpm) / 60), velocity: n.velocity }));
  if (o.quantize) notes = quantizeNotes(notes, o.quantize, o.strength ?? 1);
  const s = useStore.getState();
  let track = o.trackId ? getTrack(s.project, o.trackId) : undefined;
  if (track && track.kind !== 'instrument') throw new Error('MIDI goes on an instrument track');
  if (!track) {
    track = makeTrack(s.project, 'instrument', o.instrument ?? 'felt-piano', 'Hummed melody');
    const t = track;
    s.commit((d) => void d.tracks.push(t));
  }
  const length = Math.max(BEATS_PER_BAR, Math.ceil(Math.max(...notes.map((n) => n.start + n.duration)) / BEATS_PER_BAR) * BEATS_PER_BAR);
  const region: Region = { id: uid('rgn'), trackId: track.id, name: 'Melody', start: startBeat, length, notes: notes.map((n): Note => ({ id: uid('n'), ...n })) };
  s.commit((d) => void d.regions.push(region));
  s.selectRegion(region);
  return { region_id: region.id, track_id: track.id, notes: region.notes.map((n) => ({ pitch: n.pitch, start: +n.start.toFixed(3), duration: +n.duration.toFixed(3), velocity: n.velocity })) };
}
