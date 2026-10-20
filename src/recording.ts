// Microphone recording (audio clips or "hum a melody") and audio → MIDI conversion.
import * as Tone from 'tone';
import { create } from 'zustand';
import type { Note, Region } from './types';
import { BEATS_PER_BAR, clamp, uid } from './music';
import { getRegion, getTrack, makeTrack, useStore } from './store';
import { engine } from './audio/engine';
import { encodeMonoWav, getBuffer, importSample } from './audio/samples';
import { addAudioRegion } from './importers';
import { pitchTrackInWorker } from './analysis/client';
import { quantizeNotes, snapToScale } from './analysis/pitchtrack';
import { scalePitchClasses } from './analysis/key';
import { emitStudioEvent } from './events';
import { beginFlubTake, bindPendingFlubs, flushPendingFlubs } from './flubLive';
import { monitorLatency, punchComposite, recordingPlan, splitPasses, type Punch } from './punch';
import { needsProcessing } from './audio/processed';
import { nextTakeName, withTakes } from './takes';
import { t } from './i18n';

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

// The worklet forwards input blocks (2048 frames per channel) with their audio time; every channel of
// the input device (multi-input interfaces: one channel per armed track, F25).
const WORKLET = `
class OpenBandRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.bufs = null; this.n = 0; this.t = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      if (!this.bufs || this.bufs.length !== input.length) { this.bufs = input.map(() => new Float32Array(2048)); this.n = 0; }
      if (this.n === 0) this.t = currentTime;
      for (let c = 0; c < input.length; c++) this.bufs[c].set(input[c], this.n);
      this.n += input[0].length;
      if (this.n >= 2048) { this.port.postMessage({ t: this.t, d: this.bufs }); this.bufs = input.map(() => new Float32Array(2048)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('openband-recorder', OpenBandRecorder);`;

let session: { stop: () => void } | null = null;
const loaded = new WeakSet<BaseAudioContext>();

// ---------------------------------------------------------------- inputs, arming, punch (F25)

export interface InputDevice {
  id: string;
  label: string;
}
export interface RecSetup {
  /** Input device (null = the default microphone). */
  deviceId: string | null;
  devices: InputDevice[];
  /** Armed audio tracks → the input channel each records (0-based). */
  armed: Record<string, number>;
  punch: Punch;
  /** Hear the input while recording (with the device's latency). */
  monitor: boolean;
}
export const useRecSetup = create<RecSetup>(() => ({ deviceId: null, devices: [], armed: {}, punch: { enabled: false, inBeat: 0, outBeat: 8, preRollBars: 1 }, monitor: false }));

/** The audio inputs (names appear once the user has allowed the microphone). */
export async function listInputs(): Promise<InputDevice[]> {
  const all = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
  const devices = all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
  useRecSetup.setState({ devices });
  return devices;
}

/** Arm an audio track to record input channel `channel` (null disarms). */
export function armTrack(trackId: string, channel: number | null) {
  const t = getTrack(useStore.getState().project, trackId);
  if (!t) throw new Error(`Track "${trackId}" not found`);
  if (t.kind !== 'audio') throw new Error('Only audio tracks record from an input');
  const armed = { ...useRecSetup.getState().armed };
  if (channel === null) delete armed[trackId];
  else armed[trackId] = Math.max(0, Math.min(31, Math.round(channel)));
  useRecSetup.setState({ armed });
  return armed;
}

export function setPunch(p: Partial<Punch>) {
  const punch = { ...useRecSetup.getState().punch, ...p };
  if (punch.enabled && !(punch.outBeat > punch.inBeat)) throw new Error('The punch-out must be after the punch-in');
  useRecSetup.setState({ punch });
  return punch;
}

export interface RecordOptions {
  mode: MicMode;
  trackId?: string;
  startBeat?: number;
  /** Stop automatically after this many bars (otherwise when the user stops). */
  bars?: number;
  /** Use the armed tracks, the punch range and loop recording (default true for audio). */
  useSetup?: boolean;
}

export interface RecordResult {
  region_id: string;
  track_id: string;
  seconds: number;
  midi?: { region_id: string; track_id: string; notes: number };
  /** Every track recorded (several when several tracks are armed). */
  recorded?: { track_id: string; region_id: string; take_id?: string; kind: 'region' | 'punch' | 'loop'; takes?: number }[];
}

const FADE = 0.005;

/** Record with a count-in (or a pre-roll before a punch-in). Resolves when the take is stored. */
export async function recordFromMic(o: RecordOptions): Promise<RecordResult> {
  if (session) throw new Error('Already recording');
  const st = useStore.getState();
  const p = st.project;
  const setup = useRecSetup.getState();
  const useSetup = o.mode === 'audio' && o.useSetup !== false;
  const armedTargets = useSetup ? Object.entries(setup.armed).filter(([id]) => getTrack(p, id)?.kind === 'audio') : [];
  const targets = armedTargets.length ? armedTargets.map(([trackId, channel]) => ({ trackId, channel })) : [{ trackId: o.trackId, channel: 0 }];
  const channels = Math.max(...targets.map((t) => t.channel)) + 1;
  const startBeat = Math.max(0, o.startBeat ?? Math.floor(engine.position / BEATS_PER_BAR) * BEATS_PER_BAR);
  const punch = useSetup && setup.punch.enabled ? setup.punch : null;
  const loopRec = useSetup && !punch && p.loop.enabled && o.bars === undefined;
  const plan = recordingPlan({ startBeat: loopRec ? p.loop.start : startBeat, bpm: p.bpm, punch, bars: o.bars });
  const spb = 60 / p.bpm;
  const ctx = Tone.getContext().rawContext as unknown as AudioContext;
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: { deviceId: setup.deviceId ? { exact: setup.deviceId } : undefined, channelCount: { ideal: channels }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    .catch((e) => {
      throw new Error(`Microphone not available: ${(e as Error).message}`);
    });
  if (!loaded.has(ctx)) {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    loaded.add(ctx);
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'openband-recorder', { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink).connect(ctx.destination);
  // Optional input monitoring, with a word about its latency.
  let monitorGain: GainNode | null = null;
  if (setup.monitor) {
    monitorGain = ctx.createGain();
    source.connect(monitorGain).connect(ctx.destination);
    const lat = monitorLatency(ctx.baseLatency || 0, ctx.outputLatency || 0);
    if (lat.noticeable) st.notify(t('rec.monitorLatency', { ms: lat.ms }));
  }
  const chunks: { t: number; d: Float32Array[] }[] = [];
  node.port.onmessage = (ev) => {
    chunks.push(ev.data);
    let s = 0;
    for (const x of (ev.data.d as Float32Array[])[0]) s += x * x;
    useMic.setState({ level: Math.min(1, Math.sqrt(s / 2048) * 4) });
  };

  // Count-in (or pre-roll), then the transport from where the plan says. A punch ignores the song's loop.
  useMic.setState({ state: 'countin', mode: o.mode, error: null });
  if (engine.playing) engine.stop();
  engine.position = plan.transportFrom;
  engine.metronomeForced = true;
  const transport = Tone.getTransport();
  const loopWas = transport.loop;
  if (punch) transport.loop = false;
  let stopped = false;
  session = { stop: () => void (stopped = true) };
  const t0 = await engine.playWithCountIn(plan.countInBeats);
  st.set({ isPlaying: true });
  const endTime = plan.keepTo !== Infinity ? t0 + plan.keepTo + (punch ? FADE + 0.05 : 0) : Infinity;
  const recordFrom = t0 + plan.keepFrom;

  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      const now = ctx.currentTime;
      if (now < recordFrom) {
        const left = Math.ceil(((recordFrom - now) * p.bpm) / 60);
        if (left !== useMic.getState().countdown) useMic.setState({ countdown: left });
      } else if (useMic.getState().state === 'countin') {
        useMic.setState({ state: 'recording', countdown: 0 });
        beginFlubTake({ trackId: targets[0].trackId, pass: () => 0 });
      }
      if (stopped || now >= endTime + 0.05 || (now > t0 + 0.2 && !engine.playing)) {
        clearInterval(tick);
        resolve();
      }
    }, 30);
  });

  engine.stop();
  engine.metronomeForced = false;
  transport.loop = loopWas;
  useStore.getState().set({ isPlaying: false });
  stream.getTracks().forEach((tr) => tr.stop());
  source.disconnect();
  node.disconnect();
  monitorGain?.disconnect();
  session = null;
  useMic.setState({ state: 'processing', level: 0 });

  try {
    if (!chunks.length) throw new Error('No audio came from the microphone');
    // Sound that reached the speakers at t0 comes back through the mic `latency` later.
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + useMic.getState().offsetMs / 1000;
    const lead = punch ? FADE : 0;
    const fromS = Math.max(0, Math.round((recordFrom - lead + latency - chunks[0].t) * ctx.sampleRate));
    const channelPcm = (c: number) => {
      const all = new Float32Array(chunks.length * 2048);
      chunks.forEach((ch, i) => all.set(ch.d[Math.min(c, ch.d.length - 1)], i * 2048));
      const toS = Math.min(all.length, endTime === Infinity ? all.length : Math.round((endTime + latency - chunks[0].t) * ctx.sampleRate));
      return all.subarray(fromS, toS);
    };
    const tx = useStore.getState().beginTransaction(o.mode === 'hum' ? 'Hummed melody' : punch ? 'Punch-in' : 'Audio recording', 'ui');
    try {
      const recorded: NonNullable<RecordResult['recorded']> = [];
      let first: { region: Region; seconds: number } | null = null;
      const n0 = p.regions.filter((r) => r.audio).length;
      for (const [k, target] of targets.entries()) {
        const pcm = channelPcm(target.channel);
        if (pcm.length < ctx.sampleRate * 0.1) throw new Error('The recording is too short');
        const track = target.trackId ? getTrack(useStore.getState().project, target.trackId) : undefined;
        const name = `Recording ${n0 + k + 1}${targets.length > 1 ? ` (in ${target.channel + 1})` : ''}.wav`;
        if (punch && track) {
          const r = await punchInto(track.id, pcm, punch, ctx.sampleRate, name, p.bpm);
          recorded.push({ track_id: track.id, ...r });
          first ??= { region: getRegion(useStore.getState().project, r.region_id)!, seconds: pcm.length / ctx.sampleRate };
          continue;
        }
        if (loopRec && track !== undefined) {
          const pass = Math.round((p.loop.end - p.loop.start) * spb * ctx.sampleRate);
          const passes = splitPasses(pcm, pass);
          if (passes.length > 1) {
            const r = await loopTakes(track.id, passes, ctx.sampleRate, name, p.loop.start, p.loop.end - p.loop.start);
            recorded.push({ track_id: track.id, ...r });
            first ??= { region: getRegion(useStore.getState().project, r.region_id)!, seconds: pass / ctx.sampleRate };
            continue;
          }
        }
        const info = await importSample(encodeMonoWav(pcm, ctx.sampleRate), name);
        const region = addAudioRegion(info, { trackId: track?.kind === 'audio' ? track.id : undefined, startBeat: plan.regionStart });
        useStore.getState().commit((d) => bindPendingFlubs(d, d.regions.find((r) => r.id === region.id)));
        recorded.push({ track_id: region.trackId, region_id: region.id, kind: 'region' });
        first ??= { region, seconds: info.duration };
      }
      const region = first!.region;
      emitStudioEvent({ kind: 'region_recorded', region_id: region.id });
      const result: RecordResult = { region_id: region.id, track_id: region.trackId, seconds: +first!.seconds.toFixed(2), ...(recorded.length > 1 || punch || loopRec ? { recorded } : {}) };
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

/**
 * A punch on a track: over an existing audio clip (not stretched) it becomes a new take of that clip —
 * the old audio with only the punched range replaced, 5 ms crossfades at the edges; elsewhere a new clip.
 */
async function punchInto(trackId: string, pcm: Float32Array, punch: Punch, sr: number, name: string, bpm: number): Promise<{ region_id: string; take_id?: string; kind: 'punch' | 'region' }> {
  const spb = 60 / bpm;
  const proj = useStore.getState().project;
  const host = proj.regions.find((r) => r.trackId === trackId && r.audio && !needsProcessing(r.audio, bpm) && r.start <= punch.inBeat + 1e-9 && r.start + r.length >= punch.outBeat - 1e-9);
  const src = host ? getBuffer(host.audio!.sampleId) : undefined;
  if (!host || !src) {
    // Nothing to punch into: the take becomes a clip of its own (without the crossfade lead-in).
    const info = await importSample(encodeMonoWav(pcm.subarray(Math.round(FADE * sr)), sr), name);
    const r = addAudioRegion(info, { trackId, startBeat: punch.inBeat, lengthBeats: punch.outBeat - punch.inBeat });
    return { region_id: r.id, kind: 'region' };
  }
  // The clip as it plays (from its offset), at the recording's sample rate.
  const len = Math.round(host.length * spb * sr);
  const orig = new Float32Array(len);
  const ch0 = src.getChannelData(0);
  const ratio = src.sampleRate / sr;
  const off = host.audio!.offset * src.sampleRate;
  for (let i = 0; i < len; i++) {
    const j = off + i * ratio;
    const k = Math.floor(j);
    orig[i] = k + 1 < ch0.length ? ch0[k] + (ch0[k + 1] - ch0[k]) * (j - k) : 0;
  }
  const inS = Math.round((punch.inBeat - host.start) * spb * sr);
  const outS = Math.round((punch.outBeat - host.start) * spb * sr);
  const composite = punchComposite(orig, pcm, inS, outS, Math.round(FADE * sr));
  const info = await importSample(encodeMonoWav(composite, sr), name.replace(/\.wav$/, ' (punch).wav'));
  const { takes } = withTakes(host, Date.now(), () => uid('take'));
  const take = { id: uid('take'), name: nextTakeName(takes), notes: [], audio: { sampleId: info.id, offset: 0, gain: host.audio!.gain }, createdAt: Date.now(), author: 'user' as const };
  useStore.getState().commit((d) => {
    const x = d.regions.find((r) => r.id === host.id)!;
    x.takes = [...takes, take];
    x.activeTakeId = take.id;
    x.audio = { ...take.audio };
  });
  return { region_id: host.id, take_id: take.id, kind: 'punch' };
}

/** Loop recording: one region over the cycle, one take per pass, the last one active. */
async function loopTakes(trackId: string | undefined, passes: Float32Array[], sr: number, name: string, start: number, length: number): Promise<{ region_id: string; kind: 'loop'; takes: number }> {
  const samples = [];
  for (const [i, pcm] of passes.entries()) samples.push(await importSample(encodeMonoWav(pcm, sr), name.replace(/\.wav$/, ` take ${i + 1}.wav`)));
  const region = addAudioRegion(samples[samples.length - 1], { trackId, startBeat: start, lengthBeats: length });
  const takes = samples.map((info, i) => ({ id: uid('take'), name: `Take ${i + 1}`, notes: [], audio: { sampleId: info.id, offset: 0, gain: 1 }, createdAt: Date.now() + i, author: 'user' as const }));
  useStore.getState().commit((d) => {
    const x = d.regions.find((r) => r.id === region.id)!;
    x.takes = takes;
    x.activeTakeId = takes[takes.length - 1].id;
    x.audio = { ...takes[takes.length - 1].audio };
  });
  return { region_id: region.id, kind: 'loop', takes: takes.length };
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
