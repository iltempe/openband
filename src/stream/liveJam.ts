// Live jam (E5, SPEC v0.6 §2.5): an OMEP engine that plays in real time (stream.jam — Magenta RealTime 2,
// or the mock) streams audio into a track while the transport runs. The local server opens the session and
// relays the socket (server/streams.mjs); here the stream is anchored to a bar line, every frame is played
// at the beat it carries (jitter.ts decides what is still on time and how far ahead the engine must work),
// and what arrives is recorded: stopping keeps it as a region — or as a take of the jam already there.
// Online, without an engine on this computer, the jam mode (F15: MIDI answers from the AI) takes its place.
import * as Tone from 'tone';
import { create } from 'zustand';
import { decodeFrame, frameBeats } from '../../omep/lib/stream.mjs';
import { JitterBuffer } from './jitter';
import { bridgeUrl, engineRequest, useBridge } from '../bridge';
import { refreshEngines } from '../ensemble/engines';
import { buildContext } from '../ensemble/context';
import type { EngineInfo } from '../ensemble/router';
import { engine } from '../audio/engine';
import { encodeWavChannels, importSample } from '../audio/samples';
import { BEATS_PER_BAR, uid } from '../music';
import { getTrack, isAiCommand, makeTrack, useStore } from '../store';
import type { LedgerEntry, Region, Take } from '../types';

export interface LiveJamStats {
  leadMs: number;
  rttMs: number | null;
  genMs: number | null;
  received: number;
  late: number;
  underruns: number;
  /** Seconds of stream recorded so far. */
  seconds: number;
}

interface LiveJamState {
  status: 'off' | 'opening' | 'live';
  engine: string | null;
  engineName: string | null;
  trackId: string | null;
  style: string;
  intensity: number;
  chords: string[] | null;
  recording: boolean;
  stats: LiveJamStats;
  error: string | null;
}

const EMPTY: LiveJamStats = { leadMs: 0, rttMs: null, genMs: null, received: 0, late: 0, underruns: 0, seconds: 0 };
export const useLiveJam = create<LiveJamState>(() => ({ status: 'off', engine: null, engineName: null, trackId: null, style: '', intensity: 0.5, chords: null, recording: true, stats: EMPTY, error: null }));

const st = () => useStore.getState();
const NO_ENGINE =
  'A live jam needs an engine that streams (stream.jam: Magenta RealTime 2, or omep-mock-stream) in ~/.openband/engines.json, and the OpenBand app or npx openband on this computer. Online, use jam mode instead (set_jam_mode): the AI answers your phrases with MIDI.';

/** Engines that can stream. */
export async function streamEngines(): Promise<EngineInfo[]> {
  if (!useBridge.getState().engines) return [];
  return (await refreshEngines(true)).filter((e) => !!e.manifest.capabilities?.['stream.jam']);
}

interface Chunk {
  beat: number;
  frames: number;
  samples: Float32Array;
}

class Session {
  ws!: WebSocket;
  relay = '';
  ctx = Tone.getContext().rawContext as AudioContext;
  bpm = 120;
  spb = 0.5;
  /** AudioContext time of stream beat 0, and the transport beat it is. */
  t0 = 0;
  startBeat = 0;
  epoch = 1;
  jb!: JitterBuffer;
  bus: GainNode;
  sources = new Set<AudioBufferSourceNode>();
  /** The first take: what arrived in epoch 1 (until the transport stopped or moved). */
  chunks: Chunk[] = [];
  recordEpoch = 1;
  /** The transport beat the recording starts at (stream beat 0 of its epoch). */
  recordStart = 0;
  clockSeq = 0;
  rtt: number | null = null;
  genMs: number | null = null;
  timers: ReturnType<typeof setInterval>[] = [];
  playing = true;
  meta: { engine: string; engineName: string; engineVersion?: string; license: LedgerEntry['license'] } | null = null;

  constructor(readonly trackId: string) {
    this.bus = this.ctx.createGain();
  }

  /** The stream starts on the next bar at least `leadMs` (plus margin) away. */
  anchor(leadMs: number) {
    const t = Tone.getTransport();
    this.bpm = t.bpm.value;
    this.spb = 60 / this.bpm;
    const now = this.ctx.currentTime;
    const beat = t.getTicksAtTime(now) / t.PPQ;
    const earliest = beat + (leadMs / 1000 + 0.15) / this.spb;
    this.startBeat = Math.ceil(earliest / BEATS_PER_BAR - 1e-9) * BEATS_PER_BAR;
    this.t0 = now + (this.startBeat - beat) * this.spb;
    this.jb?.setBpm(this.bpm);
  }

  streamBeat(time = this.ctx.currentTime) {
    return (time - this.t0) / this.spb;
  }

  send(msg: Record<string, unknown>) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  clock() {
    const t = Tone.getTransport();
    const playing = t.state === 'started';
    const now = this.ctx.currentTime;
    if (playing) {
      // A seek, a loop or a new tempo: the stream starts again on the next bar (a new epoch).
      const actual = t.getTicksAtTime(now) / t.PPQ;
      const expected = this.startBeat + this.streamBeat(now);
      if (!this.playing || Math.abs(actual - expected) > 0.05 || Math.abs(t.bpm.value - this.bpm) > 1e-3) this.restart();
    } else if (this.playing) this.stopSources();
    this.playing = playing;
    this.send({ type: 'clock', seq: this.clockSeq++, beat: this.streamBeat(now), bpm: this.bpm, playing, lead_ms: Math.round(this.jb.leadMs), ...(this.rtt !== null ? { rtt_ms: +this.rtt.toFixed(1) } : {}), epoch: this.epoch, sent_ms: performance.now() });
  }

  restart() {
    this.epoch++;
    // The transport only now really started (or nothing was recorded yet): the take begins here.
    if (!this.chunks.length) this.recordEpoch = this.epoch;
    this.stopSources();
    this.jb.reset();
    this.anchor(this.jb.leadMs);
  }

  stopSources() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // not started
      }
    }
    this.sources.clear();
  }

  onFrame(data: ArrayBuffer) {
    const f = decodeFrame(data);
    if (f.epoch !== (this.epoch & 0xffff) || !this.playing) return;
    const beats = frameBeats(f.frames, f.sampleRate, this.bpm);
    if (!this.jb.arrive({ seq: f.seq, beat: f.beat, beats }, this.streamBeat(), performance.now())) return;
    const buf = this.ctx.createBuffer(f.channels, f.frames, f.sampleRate);
    for (let c = 0; c < f.channels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < f.frames; i++) ch[i] = f.samples[i * f.channels + c];
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.bus);
    src.start(this.t0 + f.beat * this.spb);
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    if (useLiveJam.getState().recording && this.epoch === this.recordEpoch) {
      if (!this.chunks.length) this.recordStart = this.startBeat;
      this.chunks.push({ beat: f.beat, frames: f.frames, samples: f.samples });
    }
  }

  onText(text: string) {
    let m: { type?: string; sent_ms?: number; gen_ms?: number; message?: string };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.type === 'clock_ack' && typeof m.sent_ms === 'number') {
      const r = performance.now() - m.sent_ms;
      this.rtt = this.rtt === null ? r : this.rtt * 0.8 + r * 0.2;
      if (typeof m.gen_ms === 'number') this.genMs = m.gen_ms;
    }
    if (m.type === 'error') useLiveJam.setState({ error: String(m.message ?? 'engine error') });
  }

  /** The recording as one stereo 48 kHz buffer, from stream beat 0. */
  recorded(): { channels: Float32Array[]; beats: number } | null {
    if (!this.chunks.length) return null;
    const sr = 48000;
    const spb = this.spb;
    const end = Math.max(...this.chunks.map((c) => c.beat * spb * sr + c.frames));
    const L = new Float32Array(Math.ceil(end));
    const R = new Float32Array(Math.ceil(end));
    for (const c of this.chunks) {
      const at = Math.round(c.beat * spb * sr);
      for (let i = 0; i < c.frames; i++) {
        L[at + i] = c.samples[i * 2];
        R[at + i] = c.samples[i * 2 + 1];
      }
    }
    return { channels: [L, R], beats: end / sr / spb };
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopSources();
    try {
      this.ws?.close();
    } catch {
      // closed
    }
    setTimeout(() => this.bus.disconnect(), 200);
  }
}

let session: Session | null = null;

export interface StartLiveJamArgs {
  engine?: string;
  track_id?: string;
  style?: string;
  intensity?: number;
  chords?: string[];
  record?: boolean;
}

export async function startLiveJam(a: StartLiveJamArgs = {}) {
  if (session) throw new Error('A live jam is already playing: stop_live_jam first');
  if (!useBridge.getState().engines) throw new Error(NO_ENGINE);
  const engines = await streamEngines();
  const pick = a.engine ? engines.find((e) => e.id === a.engine) : engines[0];
  if (!pick) throw new Error(a.engine ? `No streaming engine "${a.engine}" (engines that can: ${engines.map((e) => e.id).join(', ') || 'none'})` : NO_ENGINE);
  let track = a.track_id ? getTrack(st().project, a.track_id) : undefined;
  if (a.track_id && !track) throw new Error(`Track "${a.track_id}" not found`);
  if (track && track.kind !== 'audio') throw new Error('A live jam plays audio: use an audio track (or leave track_id out for a new one)');
  if (!track) {
    track = makeTrack(st().project, 'audio', undefined, `Live · ${pick.manifest.engine.name}`.slice(0, 40));
    const t = track;
    st().commit((d) => void d.tracks.push(t));
  }
  const intensity = a.intensity === undefined ? useLiveJam.getState().intensity : Math.max(0, Math.min(1, Number(a.intensity)));
  const style = String(a.style ?? useLiveJam.getState().style ?? '');
  useLiveJam.setState({ status: 'opening', engine: pick.id, engineName: pick.manifest.engine.name, trackId: track.id, style, intensity, chords: a.chords ?? null, recording: a.record ?? true, stats: EMPTY, error: null });
  const s = new Session(track.id);
  session = s;
  try {
    await engine.unlock();
    engine.sync(st().project);
    if (!engine.connectToTrack(track.id, s.bus)) Tone.connect(s.bus, Tone.getDestination());
    const scp = await buildContext(st().project);
    const opened = await engineRequest<{ relay: string; path: string; stream: { sample_rate?: number }; provenance?: { engine_version?: string }; license: LedgerEntry['license'] }>(
      'stream_open',
      { engine: pick.id, args: { context: scp, request: { style, intensity, ...(a.chords ? { chords: a.chords } : {}) } } },
      120000,
    );
    s.relay = opened.relay;
    s.meta = { engine: pick.id, engineName: pick.manifest.engine.name, engineVersion: opened.provenance?.engine_version ?? pick.manifest.engine.version, license: opened.license ?? pick.manifest.license };
    s.jb = new JitterBuffer({ bpm: Tone.getTransport().bpm.value });
    if (Tone.getTransport().state !== 'started') await engine.play();
    s.anchor(s.jb.leadMs);
    await new Promise<void>((ok, fail) => {
      const ws = new WebSocket(bridgeUrl().replace(/\/bridge$/, opened.path));
      ws.binaryType = 'arraybuffer';
      s.ws = ws;
      const timer = setTimeout(() => fail(new Error('The engine stream did not open')), 15000);
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          if (/"type":"ready"/.test(ev.data)) {
            clearTimeout(timer);
            ok();
          }
          s.onText(ev.data);
        } else s.onFrame(ev.data as ArrayBuffer);
      };
      ws.onerror = () => fail(new Error('The engine stream could not be reached'));
      ws.onclose = () => {
        clearTimeout(timer);
        if (session === s && useLiveJam.getState().status === 'live') useLiveJam.setState({ error: 'The engine closed the stream' });
        fail(new Error('The engine closed the stream'));
      };
    });
    s.clock();
    s.timers.push(setInterval(() => s.clock(), 50));
    s.timers.push(
      setInterval(() => {
        if (s.playing) s.jb.advance(s.streamBeat());
      }, 10),
    );
    s.timers.push(
      setInterval(() => {
        const j = s.jb.stats;
        const rec = s.chunks.reduce((n, c) => n + c.frames, 0) / 48000;
        useLiveJam.setState({ stats: { leadMs: j.leadMs, rttMs: s.rtt === null ? null : Math.round(s.rtt), genMs: s.genMs, received: j.received, late: j.late, underruns: j.underruns, seconds: +rec.toFixed(1) } });
      }, 250),
    );
    useLiveJam.setState({ status: 'live' });
    return { engine: pick.id, track_id: track.id, starts_at_bar: s.startBeat / BEATS_PER_BAR + 1, lead_ms: Math.round(s.jb.leadMs), recording: useLiveJam.getState().recording, ...(pick.manifest.license.attribution ? { attribution: pick.manifest.license.attribution } : {}) };
  } catch (e) {
    s.close();
    if (s.relay) void engineRequest('stream_close', { relay: s.relay }).catch(() => {});
    session = null;
    useLiveJam.setState({ status: 'off', error: (e as Error).message });
    throw e;
  }
}

/** Steer the jam while it plays: style (words), intensity 0..1, chords (one per bar, repeating). */
export function steerLiveJam(a: { style?: string; intensity?: number; chords?: string[] }) {
  if (!session) throw new Error('No live jam is playing (start_live_jam)');
  const msg: Record<string, unknown> = { type: 'control' };
  if (typeof a.style === 'string') msg.style = a.style;
  if (a.intensity !== undefined) msg.intensity = Math.max(0, Math.min(1, Number(a.intensity)));
  if (Array.isArray(a.chords)) msg.chords = a.chords.map(String);
  session.send(msg);
  useLiveJam.setState((s) => ({ style: (msg.style as string) ?? s.style, intensity: (msg.intensity as number) ?? s.intensity, chords: (msg.chords as string[]) ?? s.chords }));
  return { ...jamStats(), steered: Object.keys(msg).filter((k) => k !== 'type') };
}

export function liveJamStatus() {
  return jamStats();
}

function jamStats() {
  const j = useLiveJam.getState();
  return { status: j.status, engine: j.engine, track_id: j.trackId, style: j.style, intensity: j.intensity, recording: j.recording, ...(session ? { started_at_bar: session.startBeat / BEATS_PER_BAR + 1 } : {}), stats: j.stats, ...(j.error ? { error: j.error } : {}) };
}

/** Stop the stream. keep (default): what was recorded becomes a region on the jam's track — or a take, when a jam already starts there. */
export async function stopLiveJam(a: { keep?: boolean } = {}) {
  const s = session;
  if (!s) throw new Error('No live jam is playing');
  session = null;
  const stats = { ...s.jb.stats, rttMs: s.rtt === null ? null : Math.round(s.rtt) };
  s.close();
  void engineRequest('stream_close', { relay: s.relay }).catch(() => {});
  useLiveJam.setState({ status: 'off' });
  const rec = a.keep === false ? null : s.recorded();
  if (!rec || rec.beats < 0.5) return { kept: false, stats, ...(a.keep === false ? {} : { note: 'Nothing was recorded' }) };
  const wav = encodeWavChannels(rec.channels, 48000);
  const info = await importSample(wav, `live-jam-${s.meta?.engine ?? 'engine'}-${Date.now().toString(36)}.wav`);
  const length = +rec.beats.toFixed(4);
  const clip = { sampleId: info.id, offset: 0, gain: 1, stretch: { mode: 'off' as const, originalBpm: s.bpm } };
  const p = st().project;
  const there = p.regions.find((r) => r.trackId === s.trackId && r.audio && Math.abs(r.start - s.recordStart) < 1e-3);
  const now = Date.now();
  const take: Take = { id: uid('take'), name: `Jam ${(there?.takes?.length ?? (there ? 1 : 0)) + 1} · ${s.meta?.engineName ?? 'engine'}`, notes: [], audio: clip, createdAt: now, author: 'ai' };
  const regionId = there?.id ?? uid('rgn');
  const entry: LedgerEntry = {
    id: uid('ctb'),
    at: now,
    source: 'engine',
    engine: s.meta?.engine ?? 'engine',
    ...(s.meta?.engineName ? { engineName: s.meta.engineName } : {}),
    ...(s.meta?.engineVersion ? { engineVersion: s.meta.engineVersion } : {}),
    capability: 'stream.jam',
    ...(useLiveJam.getState().style ? { request: useLiveJam.getState().style } : {}),
    requestedBy: isAiCommand() ? 'ai' : 'user',
    conform: [],
    license: s.meta?.license ?? { code: 'unknown', weights: null, commercial: 'conditional', conditions: 'unknown' },
    trackId: s.trackId,
    regionIds: [regionId],
    takeIds: [take.id],
  };
  st().commit((d) => {
    const r = d.regions.find((x) => x.id === regionId);
    if (r) {
      const first: Take[] = r.takes?.length ? [] : [{ id: uid('take'), name: `Jam 1`, notes: [], audio: { ...r.audio! }, createdAt: now - 1, author: 'ai' }];
      r.takes = [...(r.takes ?? []), ...first, take];
      r.activeTakeId = take.id;
      r.audio = { ...clip };
      r.length = Math.max(r.length, length);
      r.contribution = entry.id;
    } else {
      const region: Region = { id: regionId, trackId: s.trackId, name: `Live jam · ${s.meta?.engineName ?? ''}`.trim(), start: s.recordStart, length, notes: [], audio: clip, contribution: entry.id };
      d.regions.push(region);
    }
    d.ledger = [...(d.ledger ?? []), entry];
  });
  return { kept: true, region_id: regionId, take_id: there ? take.id : undefined, start_bar: s.recordStart / BEATS_PER_BAR + 1, bars: +(length / BEATS_PER_BAR).toFixed(2), seconds: +(length * s.spb).toFixed(2), stats };
}

/** For the e2e and diagnostics: where stream beat 0 sounds (AudioContext time) and the tempo. */
export function liveJamAnchor() {
  return session ? { t0: session.t0, start_beat: session.startBeat, bpm: session.bpm, epoch: session.epoch } : null;
}
