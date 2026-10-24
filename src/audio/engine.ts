// Live audio engine: keeps a Tone.js graph in sync with the Project state.
import * as Tone from 'tone';
import type { AutoParam, Project, Track } from '../types';
import { effectiveValue, hasAutomation, isAutomated, mix } from '../automation';
import { applyFxAutomation } from './automate';
import type { WamInstance } from './wam';
import { faderToDb, sendToDb } from '../music';
import { createInstrument, customById, makeImpulse, type Instrument } from './instruments';
import { onSamplesChanged } from './samples';
import { MAX_PDC_SECONDS, NativeInstrument, desktopNative, useNativeStatus, type NativeEffect } from './native';
import { usesFrozen } from './freeze';
import { getBuffer } from './samples';
import { FxChain } from './fx';
import { MasterChainNode, loadMasterWorklets } from './master';
import { attachMeter, detachMeter } from './meters';
import { clipBuffer, ensureClipBuffer, needsProcessing, onProcessed, processingOf } from './processed';

interface TrackNode {
  presetId: string;
  instrument: Instrument;
  fx: FxChain;
  fxSignature: string;
  channel: Tone.Channel;
  meter: Tone.Meter;
  reverbSend: Tone.Gain;
  delaySend: Tone.Gain;
  /** ×1 or ×−1 (polarity). */
  polarity: Tone.Gain;
  /** Plugin delay compensation (G8): delays the track by what the slowest track's plugins add. */
  pdc: Tone.Delay;
}

interface NoteEvent {
  time: string;
  trackId: string;
  pitch: number;
  dur: number;
  vel: number;
}

const transport = () => Tone.getTransport();
export { MAX_PDC_SECONDS };

class AudioEngine {
  private nodes = new Map<string, TrackNode>();
  private parts: Tone.Part<NoteEvent>[] = [];
  private players: Tone.Player[] = [];
  private partsSignature = '';
  private samplesVersion = 0;
  private lastProject: Project | null = null;
  private master!: Tone.Gain;
  /** The master chain (G1) after the master gain: what the speakers, the meters and exports get. */
  private masterChain!: MasterChainNode;
  /** Track id → the source track keying its compressor (sidechain, G1). */
  private sidechains = new Map<string, string>();
  private masterMeter!: Tone.Meter;
  private reverb!: Tone.Convolver;
  private delay!: Tone.FeedbackDelay;
  private click!: Tone.Synth;
  private metronomeOn = false;
  /** Click forced on regardless of the project setting (count-in while recording). */
  metronomeForced = false;
  private ready = false;
  private monitor!: Tone.Gain;
  /** Monitoring only (never in exports): mono sum and the −20 dB dim, after the monitor. */
  private monoSum!: Tone.Mono;
  private dimGain!: Tone.Gain;
  /** trimDb: a level offset for level-matched comparisons (the mix pilot's "Listen before"). */
  monitoring = { mono: false, dim: false, trimDb: 0 };
  private refPlayer: Tone.Player | null = null;
  private refGain = 1;
  /** Ephemeral notes (the AI's live answers): played at absolute times, never stored in the song. */
  private phraseQueue: { trackId: string; pitch: number; time: number; duration: number; velocity: number }[] = [];
  private phraseTimer: ReturnType<typeof setInterval> | null = null;
  /** Last start per track: monophonic synths need strictly increasing start times. */
  private phraseLast = new Map<string, number>();
  /** True while the reference track is heard instead of the mix. */
  listeningToReference = false;

  private setup() {
    if (this.ready) return;
    this.ready = true;
    // master → monitor → speakers; the monitor is what the reference A/B switch fades out.
    this.dimGain = new Tone.Gain(1).toDestination();
    this.monoSum = new Tone.Mono();
    this.monitor = new Tone.Gain(1).connect(this.dimGain);
    this.masterChain = new MasterChainNode();
    this.masterChain.output.connect(this.monitor);
    this.master = new Tone.Gain(1).connect(this.masterChain.input);
    void attachMeter('master', this.masterChain.output);
    this.applyMonitoring();
    this.masterMeter = new Tone.Meter({ smoothing: 0.85 });
    this.masterChain.output.connect(this.masterMeter);
    this.reverb = new Tone.Convolver(makeImpulse(2.8, 3.2)).connect(this.master);
    this.delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.34, wet: 1 }).connect(this.master);
    this.click = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
      volume: -8,
    }).toDestination();
    const PPQ = transport().PPQ;
    new Tone.Loop((time) => {
      if (!this.metronomeOn && !this.metronomeForced) return;
      const beat = Math.round(transport().getTicksAtTime(time) / PPQ) % 4;
      this.click.triggerAttackRelease(beat === 0 ? 'G6' : 'C6', 0.03, time, beat === 0 ? 1 : 0.6);
    }, '4n').start(0);
    // Automation: evaluate the curves every 32nd note, in step with the transport (loops included).
    transport().scheduleRepeat((time) => this.tickAutomation(time), '32n', 0);
    // Audio clips and sampler zones need their buffers: rebuild once a sample finishes loading.
    onSamplesChanged(() => {
      this.samplesVersion++;
      if (this.lastProject) this.syncParts(this.lastProject);
    });
    onProcessed(() => {
      this.samplesVersion++;
      if (this.lastProject) this.syncParts(this.lastProject);
    });
  }

  /** Must be called from a user gesture before audio can be heard. */
  async unlock() {
    // Without a user gesture resume() never settles, so don't let callers hang on it.
    await Promise.race([Tone.start(), new Promise((r) => setTimeout(r, 400))]);
    this.setup();
  }

  get contextRunning() {
    return Tone.getContext().state === 'running';
  }

  // ---------- transport ----------

  // Before setup() (e.g. in Node tests, where there is no audio) the transport is left alone.
  get position(): number {
    return this.ready ? transport().ticks / transport().PPQ : 0;
  }
  set position(beats: number) {
    if (this.ready) transport().ticks = Math.max(0, Math.round(beats * transport().PPQ));
  }
  get playing() {
    return transport().state === 'started';
  }
  async play() {
    await this.unlock();
    transport().start();
  }
  /**
   * Click `beats` beats, then start the transport (from the current position) exactly on the next
   * downbeat. Returns that start time in AudioContext seconds.
   */
  async playWithCountIn(beats: number): Promise<number> {
    await this.unlock();
    const at = Tone.now() + 0.05;
    const spb = 60 / transport().bpm.value;
    for (let i = 0; i < beats; i++) this.click.triggerAttackRelease(i % 4 === 0 ? 'G6' : 'C6', 0.03, at + i * spb, i % 4 === 0 ? 1 : 0.6);
    const t0 = at + beats * spb;
    transport().start(t0);
    return t0;
  }
  // ---------- reference track (A/B) ----------

  /** Reference audio, synced to the transport from bar 1 (offset/duration in seconds trim it). */
  setReference(buf: AudioBuffer | null, offset = 0, duration?: number) {
    this.setup();
    this.refPlayer?.unsync().dispose();
    this.refPlayer = null;
    if (buf) {
      this.refPlayer = new Tone.Player(buf).toDestination();
      this.refPlayer.sync().start(0, offset, duration);
    }
    this.applyAB();
  }
  /** Gain for the reference while listening to it (loudness matching). */
  setReferenceGain(g: number) {
    this.refGain = g;
    this.applyAB();
  }
  listenReference(on: boolean) {
    this.listeningToReference = on && !!this.refPlayer;
    this.applyAB();
  }
  private applyAB() {
    if (!this.ready) return;
    const b = this.listeningToReference && !!this.refPlayer;
    this.monitor.gain.rampTo(b ? 0 : 1, 0.03);
    if (this.refPlayer) this.refPlayer.volume.rampTo(b ? 20 * Math.log10(Math.max(1e-6, this.refGain)) : -Infinity, 0.03);
  }

  // ---------- ephemeral phrases (call-and-response) ----------

  /**
   * Play notes (start/duration in beats, relative to the phrase) on a track's instrument starting at
   * AudioContext time `at`. A lookahead timer hands them to the instrument just before they sound,
   * so stopping the transport can cancel what hasn't played yet. Returns when the phrase ends.
   */
  schedulePhrase(trackId: string, notes: { pitch: number; start: number; duration: number; velocity: number }[], at: number): number {
    const spb = 60 / transport().bpm.value;
    for (const n of notes) this.phraseQueue.push({ trackId, pitch: n.pitch, time: at + n.start * spb, duration: Math.max(0.03, n.duration * spb), velocity: n.velocity });
    this.phraseQueue.sort((a, b) => a.time - b.time);
    this.phraseTimer ??= setInterval(() => {
      const horizon = Tone.now() + 0.12;
      while (this.phraseQueue.length && this.phraseQueue[0].time < horizon) {
        const n = this.phraseQueue.shift()!;
        if (n.time < Tone.now() - 0.02) continue; // too late to be in time: skip it rather than play it out of time
        const at = Math.max(n.time, Tone.now(), (this.phraseLast.get(n.trackId) ?? 0) + 1e-3);
        this.phraseLast.set(n.trackId, at);
        try {
          this.nodes.get(n.trackId)?.instrument.trigger(n.pitch, n.duration, at, n.velocity);
        } catch {
          // an instrument refusing one note must not stop the phrase
        }
      }
      if (!this.phraseQueue.length && this.phraseTimer) {
        clearInterval(this.phraseTimer);
        this.phraseTimer = null;
      }
    }, 25);
    return at + Math.max(0, ...notes.map((n) => n.start + n.duration)) * spb;
  }
  cancelPhrases() {
    this.phraseQueue = [];
    if (this.phraseTimer) clearInterval(this.phraseTimer);
    this.phraseTimer = null;
  }
  /** AudioContext time "now" as the transport sees it. */
  get now() {
    return Tone.now();
  }

  stop() {
    this.cancelPhrases();
    if (!this.ready) return;
    transport().pause();
    this.nodes.forEach((n) => n.instrument.releaseAll());
  }

  // ---------- live playing ----------

  /** The track's native instrument, when it plays one (G8.7 monitoring). */
  nativeInstrument(trackId: string): NativeInstrument | null {
    const i = this.nodes.get(trackId)?.instrument;
    return i instanceof NativeInstrument ? i : null;
  }
  /** What the track's channel does to it now: linear gain (0 if muted) and pan. */
  trackMix(trackId: string): { gain: number; pan: number } {
    const n = this.nodes.get(trackId);
    if (!n) return { gain: 0, pan: 0 };
    return { gain: n.channel.mute ? 0 : Tone.dbToGain(n.channel.volume.value), pan: n.channel.pan.value };
  }

  noteOn(trackId: string, pitch: number, velocity: number) {
    this.nodes.get(trackId)?.instrument.noteOn(pitch, velocity);
  }
  noteOff(trackId: string, pitch: number) {
    this.nodes.get(trackId)?.instrument.noteOff(pitch);
  }
  preview(trackId: string, pitch: number, velocity = 0.8, seconds = 0.35) {
    if (!this.contextRunning) void this.unlock();
    this.nodes.get(trackId)?.instrument.trigger(pitch, seconds, Tone.now() + 0.01, velocity);
  }

  // ---------- meters ----------

  level(trackId: string | 'master'): number {
    const m = trackId === 'master' ? this.masterMeter : this.nodes.get(trackId)?.meter;
    if (!m) return -Infinity;
    const v = m.getValue();
    return Array.isArray(v) ? Math.max(...v) : v;
  }

  // ---------- state sync ----------

  /** A project heard in place of the song's (monitoring only, e.g. the mix pilot's "Listen before"). */
  private previewed: Project | null = null;
  private songProject: Project | null = null;
  previewProject(p: Project | null) {
    this.previewed = p;
    if (this.songProject) this.sync(this.songProject);
  }

  /** Tracks playing their frozen audio (G8.4): where their native plugins can't run. */
  private frozen = new Set<string>();
  private watchingNatives = false;

  sync(song: Project) {
    this.songProject = song;
    // A native plugin that fails to load switches its track to the frozen audio.
    if (!this.watchingNatives) {
      this.watchingNatives = true;
      useNativeStatus.subscribe((s, prev) => {
        if (Object.keys(s).some((k) => !!s[k]?.error !== !!prev[k]?.error) && this.songProject) this.sync(this.songProject);
      });
    }
    const p = this.previewed ?? song;
    this.setup();
    this.lastProject = p;
    const t = transport();
    if (Math.abs(t.bpm.value - p.bpm) > 0.001) t.bpm.value = p.bpm;
    t.loop = p.loop.enabled && p.loop.end > p.loop.start;
    if (t.loop) {
      t.loopStart = `${Math.round(p.loop.start * t.PPQ)}i`;
      t.loopEnd = `${Math.round(p.loop.end * t.PPQ)}i`;
    }
    this.master.gain.rampTo(Math.pow(10, faderToDb(p.masterVolume) / 20) || 0, 0.05);
    this.masterChain.update(p.master);
    this.metronomeOn = p.metronome;

    const alive = new Set(p.tracks.map((tr) => tr.id));
    for (const [id, node] of this.nodes) {
      if (!alive.has(id)) {
        this.disposeNode(node);
        this.nodes.delete(id);
        detachMeter(id);
      }
    }
    const failed = (key: string) => !!useNativeStatus.getState()[key]?.error;
    this.frozen = new Set(p.tracks.filter((t) => usesFrozen(p, t, { desktop: !!desktopNative(), failed })).map((t) => t.id));
    for (const track of p.tracks) this.syncTrack(track);
    this.syncPdc();
    this.syncSidechains(p);
    this.syncParts(p);
  }

  private syncTrack(track: Track) {
    let node = this.nodes.get(track.id);
    // Imported instruments are rebuilt when their definition (zones, envelope) changes.
    const custom = customById(track.instrument);
    // Plugin state changes all the time while it's being played with: only its URL forces a reload.
    const signature = custom ? `${track.instrument}:${custom.source === 'wam' ? custom.wam?.url : custom.source === 'native' ? `${custom.format}:${custom.native?.id}:${custom.native?.path_hint}` : JSON.stringify(custom)}` : track.instrument;
    if (!node) {
      const channel = new Tone.Channel().connect(this.master);
      const meter = new Tone.Meter({ smoothing: 0.8 });
      channel.connect(meter);
      const reverbSend = new Tone.Gain(0).connect(this.reverb);
      const delaySend = new Tone.Gain(0).connect(this.delay);
      channel.connect(reverbSend);
      channel.connect(delaySend);
      const fx = new FxChain(track.id);
      const polarity = new Tone.Gain(1).connect(channel);
      const pdc = new Tone.Delay({ delayTime: 0, maxDelay: MAX_PDC_SECONDS }).connect(polarity);
      fx.output.connect(pdc);
      void attachMeter(track.id, channel);
      const instrument = createInstrument(track.instrument, undefined, `${track.id}:instrument`);
      instrument.output.connect(fx.input);
      const ready = (instrument as { ready?: Promise<void> }).ready;
      if (ready) void ready.then(() => this.syncPdc());
      node = { presetId: signature, instrument, fx, fxSignature: '', channel, meter, reverbSend, delaySend, polarity, pdc };
      this.nodes.set(track.id, node);
    } else if (node.presetId !== signature) {
      node.instrument.releaseAll();
      const old = node.instrument;
      setTimeout(() => old.dispose(), 1500);
      node.instrument = createInstrument(track.instrument, undefined, `${track.id}:instrument`);
      node.instrument.output.connect(node.fx.input);
      node.presetId = signature;
      const ready = (node.instrument as { ready?: Promise<void> }).ready;
      if (ready) void ready.then(() => this.syncPdc());
    }
    const ch = node.channel;
    // Mute is a gain of its own (with polarity, after the effects): Tone.Channel's mute sets the volume
    // to −∞, which the very next volume update (fader, automation) undid — the M button did nothing live.
    // After the effects means a muted track still keys a sidechain, as in the export.
    node.polarity.gain.rampTo((track.polarity ? -1 : 1) * (track.mute ? 0 : 1), 0.01);
    if (ch.solo !== track.solo) ch.solo = track.solo;
    this.applyMix(node, track, this.position);
    // A frozen track's audio has its effects in it already: the chain is bypassed.
    const frozen = this.frozen.has(track.id);
    const fxSignature = frozen ? 'frozen' : JSON.stringify(track.fx ?? null);
    if (fxSignature !== node.fxSignature) {
      node.fxSignature = fxSignature;
      node.fx.update(frozen ? undefined : track.fx);
      // Plugins report their latency once loaded.
      void node.fx.ready.then(() => this.syncPdc());
    }
  }

  /** The delay plugin compensation adds to everything (samples): the slowest track's latency. */
  pdcLatency = 0;
  /** Off only to measure what compensation does (tests). */
  pdcEnabled = true;

  /** The audio context's sample rate now. */
  sampleRateNow() {
    return Tone.getContext().sampleRate;
  }

  /** Samples of latency a plugin effect adds (compensated by PDC). */
  pluginLatency(trackId: string, slotId: string) {
    return this.nodes.get(trackId)?.fx.slotLatency(slotId) ?? 0;
  }

  /** Plugin delay compensation (G8): every track is delayed to line up with the slowest one. */
  syncPdc() {
    const sr = Tone.getContext().sampleRate;
    // A track is as late as its instrument (a native one, behind the bridge) plus its effects.
    const lat = new Map([...this.nodes].map(([id, n]) => [id, this.pdcEnabled ? n.fx.latency + ((n.instrument as { latency?: number }).latency ?? 0) : 0]));
    const max = Math.min(MAX_PDC_SECONDS * sr, Math.max(0, ...lat.values()));
    this.pdcLatency = max;
    for (const [id, n] of this.nodes) {
      const d = (max - (lat.get(id) ?? 0)) / sr;
      if (Math.abs(Number(n.pdc.delayTime.value) - d) > 1e-9) n.pdc.delayTime.setValueAtTime(d, Tone.now());
    }
  }

  /** Sidechain keys (G1): the source's signal after its effects, before its fader and mute — a muted
   *  kick still ducks the bass, as in the export. */
  private syncSidechains(p: Project) {
    for (const t of p.tracks) {
      const want = t.fx?.comp.on && t.fx.comp.sidechain && p.tracks.some((x) => x.id === t.fx!.comp.sidechain!.sourceTrackId) ? t.fx.comp.sidechain.sourceTrackId : null;
      const have = this.sidechains.get(t.id) ?? null;
      if (want === have) continue;
      const target = this.nodes.get(t.id);
      if (have) {
        const old = this.nodes.get(have);
        if (old && target) old.fx.output.disconnect(target.fx.key);
        this.sidechains.delete(t.id);
      }
      if (want && target) {
        const src = this.nodes.get(want);
        if (src) {
          src.fx.output.connect(target.fx.key);
          this.sidechains.set(t.id, want);
        }
      }
    }
    for (const id of [...this.sidechains.keys()]) if (!p.tracks.some((t) => t.id === id)) this.sidechains.delete(id);
  }

  /** Gain reduction of the master limiter (dB ≤ 0). */
  get limiterReduction() {
    return this.masterChain?.reductionDb ?? 0;
  }

  /** Volume, pan, sends and tone at a song position (automation curves or static values). */
  private applyMix(node: TrackNode, track: Track, beat: number, time?: number, onlyAutomated = false) {
    const want = (p: AutoParam) => !onlyAutomated || isAutomated(track, mix(p));
    const v = (p: AutoParam) => effectiveValue(track, p, beat);
    const ramp = time === undefined ? 0.04 : 0.03;
    if (want('volume')) node.channel.volume.rampTo(Math.max(-100, faderToDb(v('volume'))), ramp, time);
    if (want('pan')) node.channel.pan.rampTo(v('pan'), ramp, time);
    if (want('reverb')) node.reverbSend.gain.rampTo(Math.pow(10, sendToDb(v('reverb')) / 20) || 0, ramp, time);
    if (want('echo')) node.delaySend.gain.rampTo((Math.pow(10, sendToDb(v('echo')) / 20) || 0) * 0.7, ramp, time);
    if (want('tone')) node.instrument.setCutoff(v('tone'), time);
  }

  private tickAutomation(time: number) {
    const p = this.lastProject;
    if (!p) return;
    const beat = transport().getTicksAtTime(time) / transport().PPQ;
    for (const track of p.tracks) {
      if (!hasAutomation(track)) continue;
      const node = this.nodes.get(track.id);
      if (!node) continue;
      this.applyMix(node, track, beat, time, true);
      applyFxAutomation(track, beat, time, node.fx, node.instrument as { instance?: WamInstance | null; fx?: NativeEffect });
    }
  }

  /** Compressor gain reduction of a track in dB (0 when the compressor is off or idle). */
  reduction(trackId: string): number {
    return this.nodes.get(trackId)?.fx.reduction ?? 0;
  }

  private syncParts(p: Project) {
    const signature = JSON.stringify([p.regions, p.bpm, p.tracks.map((t) => t.id), this.samplesVersion, [...this.frozen], p.tracks.map((t) => t.frozen?.sampleId)]);
    if (signature === this.partsSignature) return;
    this.partsSignature = signature;
    this.parts.forEach((part) => part.dispose());
    this.parts = [];
    this.players.forEach((pl) => pl.dispose());
    this.players = [];
    const PPQ = transport().PPQ;
    // Frozen tracks play their render cache from the start of the song instead of their parts.
    for (const t of p.tracks) {
      if (!this.frozen.has(t.id) || !t.frozen) continue;
      const buffer = getBuffer(t.frozen.sampleId);
      const node = this.nodes.get(t.id);
      if (!buffer || !node) continue;
      const player = new Tone.Player({ url: new Tone.ToneAudioBuffer(buffer), fadeOut: 0.01 });
      // After the instrument (its tone filter is in the frozen audio), into the bypassed chain.
      player.connect(node.fx.input);
      player.sync().start(0);
      this.players.push(player);
    }
    for (const region of p.regions) {
      if (this.frozen.has(region.trackId)) continue;
      if (region.audio) {
        this.addAudioClip(region, p.bpm);
        continue;
      }
      const events: NoteEvent[] = region.notes
        .filter((n) => n.start < region.length && n.start >= 0)
        .map((n) => ({
          time: `${Math.round((region.start + n.start) * PPQ)}i`,
          trackId: region.trackId,
          pitch: n.pitch,
          dur: Math.min(n.duration, region.length - n.start),
          vel: n.velocity,
        }));
      if (!events.length) continue;
      const part = new Tone.Part<NoteEvent>((time, ev) => {
        const seconds = (ev.dur * 60) / transport().bpm.value;
        this.nodes.get(ev.trackId)?.instrument.trigger(ev.pitch, seconds, time, ev.vel);
      }, events);
      part.start(0);
      this.parts.push(part);
    }
  }

  /** Audio clips are transport-synced players, so they also start correctly mid-region. */
  private addAudioClip(region: Project['regions'][number], bpm: number) {
    const clip = region.audio!;
    const node = this.nodes.get(region.trackId);
    if (!node) return;
    // Stretched / pitch-shifted clips play their processed buffer; until it's ready, nothing (it's
    // computed in a worker and the parts are rebuilt when it arrives).
    const buffer = clipBuffer(clip, bpm);
    if (!buffer) {
      if (needsProcessing(clip, bpm)) void ensureClipBuffer(clip, bpm);
      return;
    }
    const offset = clip.offset * processingOf(clip, bpm).factor;
    const duration = Math.min((region.length * 60) / bpm, buffer.duration - offset);
    if (duration <= 0) return;
    const player = new Tone.Player({ url: new Tone.ToneAudioBuffer(buffer), fadeIn: 0.004, fadeOut: 0.01 });
    player.volume.value = clip.gain > 0 ? 20 * Math.log10(clip.gain) : -Infinity;
    player.connect(node.instrument.output);
    player.sync().start(`${Math.round(region.start * transport().PPQ)}i`, offset, duration);
    this.players.push(player);
  }

  /** Mono sum and dim: what you hear only — exports render their own graph without them. */
  setMonitoring(m: Partial<{ mono: boolean; dim: boolean; trimDb: number }>) {
    this.monitoring = { ...this.monitoring, ...m };
    if (this.ready) this.applyMonitoring();
  }
  private applyMonitoring() {
    this.monitor.disconnect();
    this.monoSum.disconnect();
    if (this.monitoring.mono) {
      this.monitor.connect(this.monoSum);
      this.monoSum.connect(this.dimGain);
    } else this.monitor.connect(this.dimGain);
    this.dimGain.gain.rampTo((this.monitoring.dim ? 0.1 : 1) * Math.pow(10, this.monitoring.trimDb / 20), 0.03);
  }

  /**
   * Record what the master outputs for `seconds` (tests and diagnostics: comparing the live sound with
   * the offline render). Resolves with the samples and the audio time of the first one.
   */
  captureMaster(seconds: number): Promise<{ channels: Float32Array[]; startTime: number; sampleRate: number }> {
    // An AudioWorklet recorder on the audio thread: a ScriptProcessor (main thread) drops blocks when the
    // page is busy, which made live and export look different when they weren't.
    const ctx = this.master.context.rawContext as unknown as AudioContext;
    const frames = Math.ceil(seconds * ctx.sampleRate);
    return loadMasterWorklets(ctx).then(
      (ok) =>
        new Promise((resolve, reject) => {
          if (!ok) return reject(new Error('AudioWorklet unavailable'));
          const node = new AudioWorkletNode(ctx, 'openband-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { frames } });
          node.port.onmessage = (e) => {
            Tone.disconnect(this.masterChain.output, node);
            node.disconnect();
            resolve({ channels: [e.data.l, e.data.r], startTime: e.data.startTime, sampleRate: ctx.sampleRate });
          };
          Tone.connect(this.masterChain.output, node);
          // Pulled by the graph through a silent output.
          const mute = ctx.createGain();
          mute.gain.value = 0;
          node.connect(mute).connect(ctx.destination);
        }),
    );
  }

  /** The FX chain of a track (level-matched A/B). */
  fxChain(trackId: string) {
    return this.nodes.get(trackId)?.fx;
  }

  private disposeNode(n: TrackNode) {
    n.instrument.releaseAll();
    n.instrument.dispose();
    n.fx.dispose();
    n.channel.dispose();
    n.meter.dispose();
    n.reverbSend.dispose();
    n.delaySend.dispose();
    n.polarity.dispose();
    n.pdc.dispose();
  }
}

export const engine = new AudioEngine();
