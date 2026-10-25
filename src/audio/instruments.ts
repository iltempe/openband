// Fully synthesized instrument presets — no samples, so everything is redistributable.
// Factories only use Tone constructors, so they work both in the live context and inside
// Tone.Offline() for bouncing to WAV.
import * as Tone from 'tone';
import './toneFix';
import type { CustomInstrument, TrackKind } from '../types';
import { cutoffToHz } from '../music';
import { AudioTrackInput, SampleInstrument } from './sampler';
import { WamInstrument } from './wam';
import { NativeInstrument } from './native';
import { voiceOptions } from './synthParams';

export interface InstrumentPreset {
  id: string;
  name: string;
  kind: TrackKind;
  category: string;
  description: string;
  /** Default smart-control tone for the preset. */
  cutoff: number;
}

export const PRESETS: InstrumentPreset[] = [
  { id: 'felt-piano', name: 'Felt Piano', kind: 'instrument', category: 'Keys', description: 'Soft, intimate piano', cutoff: 0.78 },
  { id: 'velvet-keys', name: 'Velvet Keys', kind: 'instrument', category: 'Keys', description: 'Vintage FM electric piano', cutoff: 0.85 },
  { id: 'retro-organ', name: 'Retro Organ', kind: 'instrument', category: 'Keys', description: 'Tonewheel organ', cutoff: 0.8 },
  { id: 'crystal-bells', name: 'Crystal Bells', kind: 'instrument', category: 'Keys', description: 'Shimmering FM bells', cutoff: 0.95 },
  { id: 'neon-lead', name: 'Neon Lead', kind: 'instrument', category: 'Synth', description: 'Analog sawtooth lead', cutoff: 0.82 },
  { id: 'pluck', name: 'Glass Pluck', kind: 'instrument', category: 'Synth', description: 'Bright pluck', cutoff: 0.9 },
  { id: 'chip', name: '8-Bit Hero', kind: 'instrument', category: 'Synth', description: 'Retro console square wave', cutoff: 0.9 },
  { id: 'sub-bass', name: 'Sub Bass', kind: 'instrument', category: 'Bass', description: 'Deep, round bass', cutoff: 0.55 },
  { id: 'acid-bass', name: 'Acid Line', kind: 'instrument', category: 'Bass', description: 'Resonant 303-style bass', cutoff: 0.7 },
  { id: 'finger-bass', name: 'Finger Bass', kind: 'instrument', category: 'Bass', description: 'Fingered electric bass', cutoff: 0.6 },
  { id: 'aurora-pad', name: 'Aurora Pad', kind: 'instrument', category: 'Pads & Strings', description: 'Wide, evolving pad', cutoff: 0.62 },
  { id: 'silk-strings', name: 'Silk Strings', kind: 'instrument', category: 'Pads & Strings', description: 'Synth string ensemble', cutoff: 0.68 },
  { id: 'kit-studio', name: 'Studio Kit', kind: 'drums', category: 'Drums', description: 'Tight, punchy pop kit', cutoff: 1 },
  { id: 'kit-808', name: 'Trap 808', kind: 'drums', category: 'Drums', description: 'Drum machine with long kick', cutoff: 1 },
  { id: 'kit-lofi', name: 'Dusty Lo-Fi', kind: 'drums', category: 'Drums', description: 'Dusty, saturated kit', cutoff: 0.72 },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);
export const AUDIO_INPUT = 'audio-input';
export const defaultPreset = (kind: TrackKind) => (kind === 'drums' ? 'kit-studio' : kind === 'audio' ? AUDIO_INPUT : 'felt-piano');

// Imported instruments live in the project; the store keeps this registry in sync.
const customs = new Map<string, CustomInstrument>();
export function setCustomInstruments(list: CustomInstrument[] = []) {
  customs.clear();
  list.forEach((c) => customs.set(c.id, c));
}
export const customById = (id: string) => customs.get(id);
export const customInstruments = () => [...customs.values()];

export interface InstrumentInfo extends InstrumentPreset {
  custom?: CustomInstrument;
}

/** Any instrument id: built-in preset, imported instrument, or the audio-track input. */
export function findInstrument(id: string): InstrumentInfo | undefined {
  const preset = presetById(id);
  if (preset) return preset;
  const c = customs.get(id);
  if (c) return { id: c.id, name: c.name, kind: c.kind, category: c.source === 'wam' || c.source === 'native' ? 'Plugins' : 'Imported', description: c.source === 'soundfont' ? 'SoundFont' : c.source === 'wam' ? 'WAM plugin' : c.source === 'native' ? `${(c.format ?? 'native').toUpperCase()} plugin` : 'Sampler', cutoff: 1, custom: c };
  if (id === AUDIO_INPUT) return { id, name: 'Audio', kind: 'audio', category: 'Audio', description: 'Audio track', cutoff: 1 };
  return undefined;
}

export interface Instrument {
  output: Tone.ToneAudioNode;
  /** duration in seconds */
  trigger(pitch: number, duration: number, time: number, velocity: number): void;
  noteOn(pitch: number, velocity: number, time?: number): void;
  noteOff(pitch: number, time?: number): void;
  /** Optional time schedules the change (automation); otherwise it applies now. */
  setCutoff(v: number, time?: number): void;
  releaseAll(): void;
  dispose(): void;
  /** Synth parameters (G5), for the presets that have them. */
  setParams?(params?: Record<string, number>): void;
}

const midiHz = (p: number) => Tone.Frequency(p, 'midi').toFrequency();

// ---------- Melodic ----------

/** A melodic preset as data: which Tone synth plays it and with what options (G5: its parameters come from here). */
export interface VoiceDef {
  synth: 'synth' | 'mono' | 'fm';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: Record<string, any>;
}

export const VOICES: Record<string, VoiceDef> = {
  'felt-piano': {
    synth: 'synth',
    options: {
      oscillator: { type: 'custom', partials: [1, 0.42, 0.24, 0.12, 0.07, 0.04, 0.02] },
      envelope: { attack: 0.004, decay: 2.4, sustain: 0.02, release: 1.1 },
      volume: -9,
    },
  },
  'velvet-keys': {
    synth: 'fm',
    options: {
      harmonicity: 2,
      modulationIndex: 3.2,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.002, decay: 1.6, sustain: 0.18, release: 1.3 },
      modulationEnvelope: { attack: 0.002, decay: 0.45, sustain: 0.12, release: 0.8 },
      volume: -11,
    },
  },
  'retro-organ': {
    synth: 'synth',
    options: {
      oscillator: { type: 'custom', partials: [1, 0.8, 0.55, 0, 0.42, 0, 0, 0.3] },
      envelope: { attack: 0.012, decay: 0.1, sustain: 0.92, release: 0.12 },
      volume: -16,
    },
  },
  'crystal-bells': {
    synth: 'fm',
    options: {
      harmonicity: 5.07,
      modulationIndex: 9,
      envelope: { attack: 0.001, decay: 2.2, sustain: 0, release: 2.2 },
      modulationEnvelope: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.9 },
      volume: -15,
    },
  },
  'neon-lead': {
    synth: 'mono',
    options: {
      oscillator: { type: 'sawtooth' },
      filter: { Q: 2, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.006, decay: 0.2, sustain: 0.75, release: 0.28 },
      filterEnvelope: { attack: 0.008, decay: 0.35, sustain: 0.45, release: 0.4, baseFrequency: 500, octaves: 3.4 },
      volume: -15,
    },
  },
  pluck: {
    synth: 'synth',
    options: {
      oscillator: { type: 'fattriangle', count: 2, spread: 18 },
      envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.35 },
      volume: -9,
    },
  },
  chip: {
    synth: 'synth',
    options: {
      oscillator: { type: 'pulse', width: 0.3 } as any,
      envelope: { attack: 0.001, decay: 0.08, sustain: 0.55, release: 0.04 },
      volume: -20,
    },
  },
  'sub-bass': {
    synth: 'mono',
    options: {
      oscillator: { type: 'triangle' },
      filter: { Q: 0.7, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.004, decay: 0.3, sustain: 0.85, release: 0.18 },
      filterEnvelope: { attack: 0.002, decay: 0.2, sustain: 0.6, release: 0.2, baseFrequency: 180, octaves: 2.2 },
      volume: -5,
    },
  },
  'acid-bass': {
    synth: 'mono',
    options: {
      oscillator: { type: 'sawtooth' },
      filter: { Q: 9, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.002, decay: 0.25, sustain: 0.4, release: 0.08 },
      filterEnvelope: { attack: 0.002, decay: 0.22, sustain: 0.08, release: 0.1, baseFrequency: 160, octaves: 4.2 },
      volume: -15,
    },
  },
  'finger-bass': {
    synth: 'mono',
    options: {
      oscillator: { type: 'custom', partials: [1, 0.6, 0.3, 0.18, 0.1] } as any,
      filter: { Q: 1.2, type: 'lowpass', rolloff: -12 },
      envelope: { attack: 0.003, decay: 0.9, sustain: 0.25, release: 0.15 },
      filterEnvelope: { attack: 0.002, decay: 0.25, sustain: 0.2, release: 0.2, baseFrequency: 220, octaves: 2.6 },
      volume: -6,
    },
  },
  'aurora-pad': {
    synth: 'synth',
    options: {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 32 },
      envelope: { attack: 0.9, decay: 0.6, sustain: 0.85, release: 2.6 },
      volume: -19,
    },
  },
  'silk-strings': {
    synth: 'synth',
    options: {
      oscillator: { type: 'fatsawtooth', count: 4, spread: 22 },
      envelope: { attack: 0.32, decay: 0.3, sustain: 0.9, release: 1.2 },
      volume: -19,
    },
  },
};

const SYNTHS = { synth: Tone.Synth, mono: Tone.MonoSynth, fm: Tone.FMSynth } as const;

class MelodicInstrument implements Instrument {
  output: Tone.Filter;
  private synth: Tone.PolySynth;
  /** The voice filter of presets that have none of their own (G5 cutoff and resonance). */
  private voiceFilter: Tone.Filter;
  private params = '';

  constructor(private presetId: string, params?: Record<string, number>) {
    const v = voiceOptions(presetId, params);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.synth = new Tone.PolySynth(SYNTHS[v.synth] as any, v.options);
    this.synth.maxPolyphony = 24;
    this.voiceFilter = new Tone.Filter({ type: 'lowpass', frequency: this.belowNyquist(v.filter.frequency), Q: v.filter.Q, rolloff: -12 });
    this.output = new Tone.Filter({ type: 'lowpass', frequency: this.belowNyquist(16000), rolloff: -12, Q: 0.5 });
    this.synth.connect(this.voiceFilter);
    this.voiceFilter.connect(this.output);
    this.params = JSON.stringify(params ?? {});
  }
  /** A filter at or above Nyquist misbehaves (lower sample rates, e.g. the sound-alike search's 22 kHz renders). */
  private belowNyquist(hz: number) {
    return Math.min(hz, Tone.getContext().sampleRate * 0.45);
  }
  /** New parameters, live (G5): the voices and the filter change without rebuilding the instrument. */
  setParams(params: Record<string, number> = {}) {
    const key = JSON.stringify(params);
    if (key === this.params) return;
    this.params = key;
    const v = voiceOptions(this.presetId, params);
    this.synth.set(v.options);
    this.voiceFilter.frequency.rampTo(this.belowNyquist(v.filter.frequency), 0.03);
    this.voiceFilter.Q.rampTo(v.filter.Q, 0.03);
  }
  trigger(pitch: number, duration: number, time: number, velocity: number) {
    this.synth.triggerAttackRelease(midiHz(pitch), Math.max(0.02, duration), time, velocity);
  }
  noteOn(pitch: number, velocity: number, time?: number) {
    this.synth.triggerAttack(midiHz(pitch), time, velocity);
  }
  noteOff(pitch: number, time?: number) {
    this.synth.triggerRelease(midiHz(pitch), time);
  }
  setCutoff(v: number, time?: number) {
    this.output.frequency.rampTo(this.belowNyquist(cutoffToHz(v)), 0.05, time);
  }
  releaseAll() {
    this.synth.releaseAll();
  }
  dispose() {
    this.synth.dispose();
    this.voiceFilter.dispose();
    this.output.dispose();
  }
}

// ---------- Drums ----------

type Hit = (time: number, velocity: number) => void;

interface KitVoices {
  hits: Map<number, Hit>;
  nodes: Tone.ToneAudioNode[];
}

function buildKit(variant: string, out: Tone.ToneAudioNode): KitVoices {
  const nodes: Tone.ToneAudioNode[] = [];
  const hits = new Map<number, Hit>();
  const keep = <T extends Tone.ToneAudioNode>(n: T) => (nodes.push(n), n);
  const is808 = variant === 'kit-808';

  // Kick
  const kick = keep(
    new Tone.MembraneSynth({
      pitchDecay: is808 ? 0.09 : 0.035,
      octaves: is808 ? 4.5 : 7,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: is808 ? 1.4 : 0.42, sustain: 0, release: 0.1 },
      volume: is808 ? -2 : -3,
    }).connect(out),
  );
  hits.set(36, (t, v) => kick.triggerAttackRelease(is808 ? 'F1' : 'C1', is808 ? 1.2 : 0.4, t, v));

  // Snare = noise + body
  const snHp = keep(new Tone.Filter({ type: 'highpass', frequency: is808 ? 1800 : 1100 }).connect(out));
  const snNoise = keep(
    new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: is808 ? 0.16 : 0.2, sustain: 0 }, volume: -9 }).connect(snHp),
  );
  const snBody = keep(
    new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 2, envelope: { attack: 0.001, decay: 0.12, sustain: 0 }, volume: -10 }).connect(out),
  );
  hits.set(38, (t, v) => {
    snNoise.triggerAttackRelease(0.2, t, v);
    snBody.triggerAttackRelease('A2', 0.1, t, v);
  });

  // Clap
  const clBp = keep(new Tone.Filter({ type: 'bandpass', frequency: 1400, Q: 1.1 }).connect(out));
  const clap = keep(
    new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.003, decay: 0.18, sustain: 0 }, volume: -3 }).connect(clBp),
  );
  hits.set(39, (t, v) => clap.triggerAttackRelease(0.16, t, v));

  // Rim
  const rim = keep(
    new Tone.MembraneSynth({ pitchDecay: 0.005, octaves: 1.5, envelope: { attack: 0.001, decay: 0.05, sustain: 0 }, volume: -10 }).connect(out),
  );
  hits.set(37, (t, v) => rim.triggerAttackRelease('E5', 0.04, t, v));

  // Hats
  const hatHp = keep(new Tone.Filter({ type: 'highpass', frequency: is808 ? 8000 : 7000 }).connect(out));
  const chh = keep(
    new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.045, sustain: 0 }, volume: -12 }).connect(hatHp),
  );
  const ohh = keep(
    new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.002, decay: 0.38, sustain: 0 }, volume: -14 }).connect(hatHp),
  );
  hits.set(42, (t, v) => chh.triggerAttackRelease(0.04, t, v));
  hits.set(46, (t, v) => ohh.triggerAttackRelease(0.3, t, v));

  // Toms
  const toms: [number, string][] = [[45, 'G2'], [48, 'C3'], [50, 'F3']];
  for (const [pitch, note] of toms) {
    const tom = keep(
      new Tone.MembraneSynth({ pitchDecay: 0.03, octaves: 2.2, envelope: { attack: 0.001, decay: 0.45, sustain: 0 }, volume: -6 }).connect(out),
    );
    hits.set(pitch, (t, v) => tom.triggerAttackRelease(note, 0.4, t, v));
  }

  // Cymbals
  const crHp = keep(new Tone.Filter({ type: 'highpass', frequency: 4500 }).connect(out));
  const crash = keep(
    new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.002, decay: 1.6, sustain: 0 }, volume: -15 }).connect(crHp),
  );
  hits.set(49, (t, v) => crash.triggerAttackRelease(1.5, t, v));
  const ride = keep(
    new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.7, release: 0.2 },
      harmonicity: 5.1,
      modulationIndex: 24,
      resonance: 5000,
      octaves: 1.2,
      volume: -26,
    }).connect(out),
  );
  hits.set(51, (t, v) => ride.triggerAttackRelease(380, 0.6, t, v));

  return { hits, nodes };
}

class DrumKit implements Instrument {
  output: Tone.Filter;
  private bus: Tone.ToneAudioNode;
  private voices: KitVoices;
  private extra: Tone.ToneAudioNode[] = [];
  private last = new Map<number, number>();

  constructor(variant: string) {
    this.output = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12 });
    if (variant === 'kit-lofi') {
      const drive = new Tone.Distortion({ distortion: 0.35, wet: 0.5 }).connect(this.output);
      const tone = new Tone.Filter({ type: 'lowpass', frequency: 5200, rolloff: -12 }).connect(drive);
      this.extra.push(drive, tone);
      this.bus = tone;
    } else {
      this.bus = this.output;
    }
    this.voices = buildKit(variant, this.bus);
  }
  trigger(pitch: number, _duration: number, time: number, velocity: number) {
    const hit = this.voices.hits.get(pitch);
    if (!hit) return;
    // Monophonic voices refuse two starts at the exact same time.
    const prev = this.last.get(pitch) ?? -1;
    const t = time <= prev ? prev + 0.002 : time;
    this.last.set(pitch, t);
    hit(t, velocity);
  }
  noteOn(pitch: number, velocity: number, time?: number) {
    this.trigger(pitch, 0.2, time ?? Tone.now(), velocity);
  }
  noteOff() {}
  setCutoff(v: number, time?: number) {
    this.output.frequency.rampTo(cutoffToHz(v), 0.05, time);
  }
  releaseAll() {}
  dispose() {
    this.voices.nodes.forEach((n) => n.dispose());
    this.extra.forEach((n) => n.dispose());
    this.output.dispose();
  }
}

/** key (trackId:instrument) registers a live plugin instance for its GUI and MCP. */
export function createInstrument(presetId: string, custom = customs.get(presetId), key?: string, params?: Record<string, number>): Instrument {
  if (presetId === AUDIO_INPUT) return new AudioTrackInput();
  if (custom?.source === 'wam' && custom.wam) return new WamInstrument(custom.wam.url, custom.wam.state, key);
  if (custom?.source === 'native' && custom.native) return new NativeInstrument(custom, key);
  if (custom) return new SampleInstrument(custom);
  const preset = presetById(presetId);
  if (preset?.kind === 'drums') return new DrumKit(presetId);
  return new MelodicInstrument(presetId, params);
}

/** Small seeded PRNG (mulberry32): the reverb must sound the same on every render. */
export function seeded(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Synthetic stereo impulse response for the shared reverb (no IR files needed). Deterministic, so
 * repeated renders (exports, analysis, stems) are identical. */
export function makeImpulse(seconds: number, decay = 3): Tone.ToneAudioBuffer {
  const rate = Tone.getContext().sampleRate;
  const len = Math.floor(rate * seconds);
  const chans = [new Float32Array(len), new Float32Array(len)];
  const rnd = seeded(0x0b5e7a11);
  for (const ch of chans) {
    for (let i = 0; i < len; i++) {
      const t = i / len;
      ch[i] = (rnd() * 2 - 1) * Math.pow(1 - t, decay) * (i < rate * 0.004 ? i / (rate * 0.004) : 1);
    }
  }
  return Tone.ToneAudioBuffer.fromArray(chans);
}
