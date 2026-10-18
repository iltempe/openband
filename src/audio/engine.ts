// Live audio engine: keeps a Tone.js graph in sync with the Project state.
import * as Tone from 'tone';
import type { AutoParam, Project, Track } from '../types';
import { effectiveValue, hasAutomation } from '../automation';
import { faderToDb, sendToDb } from '../music';
import { createInstrument, customById, makeImpulse, type Instrument } from './instruments';
import { getBuffer, onSamplesChanged } from './samples';
import { FxChain } from './fx';

interface TrackNode {
  presetId: string;
  instrument: Instrument;
  fx: FxChain;
  fxSignature: string;
  channel: Tone.Channel;
  meter: Tone.Meter;
  reverbSend: Tone.Gain;
  delaySend: Tone.Gain;
}

interface NoteEvent {
  time: string;
  trackId: string;
  pitch: number;
  dur: number;
  vel: number;
}

const transport = () => Tone.getTransport();

class AudioEngine {
  private nodes = new Map<string, TrackNode>();
  private parts: Tone.Part<NoteEvent>[] = [];
  private players: Tone.Player[] = [];
  private partsSignature = '';
  private samplesVersion = 0;
  private lastProject: Project | null = null;
  private master!: Tone.Gain;
  private masterMeter!: Tone.Meter;
  private reverb!: Tone.Convolver;
  private delay!: Tone.FeedbackDelay;
  private click!: Tone.Synth;
  private metronomeOn = false;
  private ready = false;

  private setup() {
    if (this.ready) return;
    this.ready = true;
    this.master = new Tone.Gain(1).toDestination();
    this.masterMeter = new Tone.Meter({ smoothing: 0.85 });
    this.master.connect(this.masterMeter);
    this.reverb = new Tone.Convolver(makeImpulse(2.8, 3.2)).connect(this.master);
    this.delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.34, wet: 1 }).connect(this.master);
    this.click = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
      volume: -8,
    }).toDestination();
    const PPQ = transport().PPQ;
    new Tone.Loop((time) => {
      if (!this.metronomeOn) return;
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
  stop() {
    if (!this.ready) return;
    transport().pause();
    this.nodes.forEach((n) => n.instrument.releaseAll());
  }

  // ---------- live playing ----------

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

  sync(p: Project) {
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
    this.metronomeOn = p.metronome;

    const alive = new Set(p.tracks.map((tr) => tr.id));
    for (const [id, node] of this.nodes) {
      if (!alive.has(id)) {
        this.disposeNode(node);
        this.nodes.delete(id);
      }
    }
    for (const track of p.tracks) this.syncTrack(track);
    this.syncParts(p);
  }

  private syncTrack(track: Track) {
    let node = this.nodes.get(track.id);
    // Imported instruments are rebuilt when their definition (zones, envelope) changes.
    const custom = customById(track.instrument);
    // Plugin state changes all the time while it's being played with: only its URL forces a reload.
    const signature = custom ? `${track.instrument}:${custom.source === 'wam' ? custom.wam?.url : JSON.stringify(custom)}` : track.instrument;
    if (!node) {
      const channel = new Tone.Channel().connect(this.master);
      const meter = new Tone.Meter({ smoothing: 0.8 });
      channel.connect(meter);
      const reverbSend = new Tone.Gain(0).connect(this.reverb);
      const delaySend = new Tone.Gain(0).connect(this.delay);
      channel.connect(reverbSend);
      channel.connect(delaySend);
      const fx = new FxChain(track.id);
      fx.output.connect(channel);
      const instrument = createInstrument(track.instrument, undefined, `${track.id}:instrument`);
      instrument.output.connect(fx.input);
      node = { presetId: signature, instrument, fx, fxSignature: '', channel, meter, reverbSend, delaySend };
      this.nodes.set(track.id, node);
    } else if (node.presetId !== signature) {
      node.instrument.releaseAll();
      const old = node.instrument;
      setTimeout(() => old.dispose(), 1500);
      node.instrument = createInstrument(track.instrument, undefined, `${track.id}:instrument`);
      node.instrument.output.connect(node.fx.input);
      node.presetId = signature;
    }
    const ch = node.channel;
    if (ch.mute !== track.mute) ch.mute = track.mute;
    if (ch.solo !== track.solo) ch.solo = track.solo;
    this.applyMix(node, track, this.position);
    const fxSignature = JSON.stringify(track.fx ?? null);
    if (fxSignature !== node.fxSignature) {
      node.fxSignature = fxSignature;
      node.fx.update(track.fx);
    }
  }

  /** Volume, pan, sends and tone at a song position (automation curves or static values). */
  private applyMix(node: TrackNode, track: Track, beat: number, time?: number, onlyAutomated = false) {
    const want = (p: AutoParam) => !onlyAutomated || !!track.automation?.[p]?.length;
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
      if (node) this.applyMix(node, track, beat, time, true);
    }
  }

  /** Compressor gain reduction of a track in dB (0 when the compressor is off or idle). */
  reduction(trackId: string): number {
    return this.nodes.get(trackId)?.fx.reduction ?? 0;
  }

  private syncParts(p: Project) {
    const signature = JSON.stringify([p.regions, p.bpm, p.tracks.map((t) => t.id), this.samplesVersion]);
    if (signature === this.partsSignature) return;
    this.partsSignature = signature;
    this.parts.forEach((part) => part.dispose());
    this.parts = [];
    this.players.forEach((pl) => pl.dispose());
    this.players = [];
    const PPQ = transport().PPQ;
    for (const region of p.regions) {
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
    const buffer = getBuffer(clip.sampleId);
    const node = this.nodes.get(region.trackId);
    if (!buffer || !node) return;
    const duration = Math.min((region.length * 60) / bpm, buffer.duration - clip.offset);
    if (duration <= 0) return;
    const player = new Tone.Player({ url: new Tone.ToneAudioBuffer(buffer), fadeIn: 0.004, fadeOut: 0.01 });
    player.volume.value = clip.gain > 0 ? 20 * Math.log10(clip.gain) : -Infinity;
    player.connect(node.instrument.output);
    player.sync().start(`${Math.round(region.start * transport().PPQ)}i`, clip.offset, duration);
    this.players.push(player);
  }

  private disposeNode(n: TrackNode) {
    n.instrument.releaseAll();
    n.instrument.dispose();
    n.fx.dispose();
    n.channel.dispose();
    n.meter.dispose();
    n.reverbSend.dispose();
    n.delaySend.dispose();
  }
}

export const engine = new AudioEngine();
