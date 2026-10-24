// Per-track insert effects: amp sim → 3-band EQ → compressor. Units that are off are taken out
// of the signal path entirely, so a track without effects sounds exactly as before.
import * as Tone from 'tone';
import type { TrackFx } from '../types';
import { WamEffect, type WamInstance } from './wam';
import { loadMasterWorklets } from './master';

import { defaultFx } from '../fxDefaults';
export { defaultFx };

/** Fill in any missing section, e.g. for projects saved before a parameter existed. */
export function normalizeFx(fx?: Partial<TrackFx>): TrackFx {
  const d = defaultFx();
  return { amp: { ...d.amp, ...fx?.amp }, eq: { ...d.eq, ...fx?.eq }, comp: { ...d.comp, ...fx?.comp }, plugins: fx?.plugins ?? [], ...(fx?.trim ? { trim: fx.trim } : {}) };
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

class AmpSim {
  readonly input: Tone.Gain;
  readonly output: Tone.Gain;
  private shaper: Tone.Distortion;
  private cab: Tone.Filter;
  private lowCut: Tone.Filter;
  private presence: Tone.Filter;
  constructor() {
    this.input = new Tone.Gain(1);
    this.shaper = new Tone.Distortion({ distortion: 0.4, oversample: '4x' });
    this.lowCut = new Tone.Filter({ type: 'highpass', frequency: 90, rolloff: -12 });
    this.presence = new Tone.Filter({ type: 'peaking', frequency: 2200, Q: 0.9, gain: 3 });
    this.cab = new Tone.Filter({ type: 'lowpass', frequency: 5000, rolloff: -24, Q: 0.7 });
    this.output = new Tone.Gain(1);
    this.input.chain(this.shaper, this.lowCut, this.presence, this.cab, this.output);
  }
  set(p: TrackFx['amp'], time?: number) {
    // Pre-gain drives the waveshaper harder; level compensates so drive doesn't just mean "louder".
    this.input.gain.rampTo(1 + p.drive * 24, 0.03, time);
    this.shaper.distortion = 0.15 + p.drive * 0.85;
    this.cab.frequency.rampTo(1400 * Math.pow(2, p.tone * 2.8), 0.03);
    this.output.gain.rampTo((p.level * 1.4) / (1 + p.drive * 2), 0.03, time);
  }
  dispose() {
    [this.input, this.shaper, this.lowCut, this.presence, this.cab, this.output].forEach((n) => n.dispose());
  }
}

export class FxChain {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private amp = new AmpSim();
  private eq = new Tone.EQ3({ low: 0, mid: 0, high: 0, lowFrequency: 250, highFrequency: 3500 });
  private comp = new Tone.Compressor({ threshold: -18, ratio: 4, attack: 0.01, release: 0.18, knee: 6 });
  /** High-pass filter before the EQ (G1). */
  private hpf = new Tone.Filter({ type: 'highpass', frequency: 80, rolloff: -12 });
  /** Sidechain key input (G1): another track's signal, before its fader, drives the compressor. */
  readonly key = new Tone.Gain(1);
  /** The compressor itself (G1): an AudioWorklet, the same DSP live and offline (Web Audio's own
   *  DynamicsCompressor sounds different in the two and adds a hidden make-up gain). Tone's is only a
   *  stand-in until the worklet has loaded, or where worklets don't exist. */
  private cw: AudioWorkletNode | null = null;
  private cwLoad: Promise<void> | null = null;
  private keyed = false;
  /** Gain reduction reported by the worklet compressor (dB ≤ 0). */
  private cwReduction = 0;
  private makeup = new Tone.Gain(1);
  private routing = '';
  private plugins = new Map<string, WamEffect>();
  /** Level-matched A/B (F20): the whole chain (slotId null) or one plugin bypassed, with this gain in its place. */
  private compare: { slotId: string | null; gainDb: number } | null = null;
  private compareGain = new Tone.Gain(1);
  private last?: TrackFx;

  /** keyPrefix (the track id) registers live plugin instances for their GUI and MCP. */
  constructor(private keyPrefix?: string) {
    this.comp.connect(this.makeup);
  }

  /** Resolves when every plugin in the chain has loaded (or failed). */
  get ready() {
    return Promise.all([...[...this.plugins.values()].map((p) => p.ready), ...(this.cwLoad ? [this.cwLoad] : [])]).then(() => undefined);
  }

  private ensureComp() {
    this.cwLoad ??= (async () => {
      const raw = this.input.context.rawContext as unknown as BaseAudioContext;
      if (!(await loadMasterWorklets(raw))) return;
      this.cw = new AudioWorkletNode(raw, 'openband-comp', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      this.cw.port.onmessage = (e) => {
        if (typeof e.data?.reductionDb === 'number') this.cwReduction = e.data.reductionDb;
      };
      this.routing = '';
      this.update(this.last);
    })();
    return this.cwLoad;
  }

  /** A compressor parameter, now or at an audio time (automation). */
  private compParam(name: 'threshold' | 'ratio' | 'attack' | 'release' | 'amount', value: number, time?: number) {
    if (this.cw) {
      const p = this.cw.parameters.get(name)!;
      const ctx = this.input.context;
      const at = time ?? ctx.currentTime;
      p.cancelScheduledValues(at);
      p.setValueAtTime(p.value, at);
      p.linearRampToValueAtTime(value, at + 0.03);
    } else if (name !== 'amount') this.comp[name].rampTo(value, 0.03, time);
  }

  update(raw?: TrackFx) {
    const fx = normalizeFx(raw);
    const slots = fx.plugins ?? [];
    // Plugin instances: create new slots (with their saved state), drop removed ones.
    for (const [id, p] of this.plugins) {
      if (!slots.some((s) => s.id === id && s.url === p.url)) {
        p.dispose();
        this.plugins.delete(id);
      }
    }
    for (const s of slots) {
      if (!this.plugins.has(s.id)) this.plugins.set(s.id, new WamEffect(s.url, s.state, this.keyPrefix && `${this.keyPrefix}:${s.id}`));
      this.plugins.get(s.id)!.setBypass(!s.on);
    }
    this.last = raw;
    const cmp = this.compare;
    const hpfOn = !!fx.eq.hpf?.on;
    const side = fx.comp.on && fx.comp.sidechain ? fx.comp.sidechain : null;
    if (fx.comp.on && !this.cw) void this.ensureComp();
    const worklet = fx.comp.on && !!this.cw;
    const routing = `${fx.amp.on}${hpfOn}${fx.eq.on}${fx.comp.on}${worklet}|${slots.map((s) => s.id).join(',')}|${cmp ? `${cmp.slotId}` : ''}`;
    if (routing !== this.routing) {
      this.routing = routing;
      this.input.disconnect();
      this.amp.output.disconnect();
      this.eq.disconnect();
      this.makeup.disconnect();
      this.hpf.disconnect();
      if (this.cw) this.cw.disconnect();
      this.comp.disconnect();
      this.comp.connect(this.makeup);
      this.plugins.forEach((p) => p.output.disconnect());
      this.compareGain.disconnect();
      const stages: { in: Tone.InputNode; out: Tone.ToneAudioNode }[] = [];
      if (cmp && cmp.slotId === null) stages.push({ in: this.compareGain, out: this.compareGain });
      else {
        if (fx.amp.on) stages.push({ in: this.amp.input, out: this.amp.output });
        if (hpfOn) stages.push({ in: this.hpf, out: this.hpf });
        if (fx.eq.on) stages.push({ in: this.eq, out: this.eq });
        if (fx.comp.on && worklet) {
          Tone.connect(this.cw!, this.makeup);
          stages.push({ in: this.cw!, out: this.makeup });
        } else if (fx.comp.on) stages.push({ in: this.comp, out: this.makeup });
        for (const s of slots) {
          if (cmp?.slotId === s.id) {
            stages.push({ in: this.compareGain, out: this.compareGain });
            continue;
          }
          const p = this.plugins.get(s.id)!;
          stages.push({ in: p.input, out: p.output });
        }
      }
      let from: Tone.ToneAudioNode = this.input;
      for (const st of stages) {
        from.connect(st.in);
        from = st.out;
      }
      from.connect(this.output);
    }
    this.amp.set(fx.amp);
    this.eq.low.rampTo(fx.eq.low, 0.03);
    this.eq.mid.rampTo(fx.eq.mid, 0.03);
    this.eq.high.rampTo(fx.eq.high, 0.03);
    // Mid band centre: move both crossovers around it, keeping them in order.
    const f = Math.min(6000, Math.max(200, fx.eq.midFreq));
    this.eq.lowFrequency.rampTo(Math.max(40, f / 3), 0.03);
    this.eq.highFrequency.rampTo(Math.min(16000, f * 3), 0.03);
    this.compParam('threshold', fx.comp.threshold);
    this.compParam('ratio', fx.comp.ratio);
    this.compParam('attack', fx.comp.attack);
    this.compParam('release', fx.comp.release);
    this.compParam('amount', side ? Math.max(0, Math.min(1, side.amount)) : 1);
    // Sidechain: the key feeds the compressor's second input; without it the signal keys itself.
    if (this.cw && !!side !== this.keyed) {
      if (side) Tone.connect(this.key, this.cw, 0, 1);
      else this.key.disconnect();
      this.keyed = !!side;
    }
    this.makeup.gain.rampTo(dbToGain(fx.comp.makeup), 0.03);
    if (hpfOn) this.hpf.frequency.rampTo(Math.min(2000, Math.max(20, fx.eq.hpf!.hz)), 0.03);
    // Output trim: a level-match compensation made permanent (rendered too).
    this.output.gain.rampTo(dbToGain(fx.trim ?? 0), 0.03);
    this.compareGain.gain.rampTo(dbToGain(cmp?.gainDb ?? 0), 0.03);
  }

  /** An automated effect parameter at an audio time (F22); values in the parameter's own range. */
  setParam(unit: 'amp' | 'eq' | 'comp', param: string, value: number, time?: number) {
    const fx = normalizeFx(this.last);
    if (unit === 'amp') return this.amp.set({ ...fx.amp, [param]: value }, time);
    if (unit === 'eq') {
      if (param === 'low' || param === 'mid' || param === 'high') return void this.eq[param].rampTo(value, 0.03, time);
      if (param === 'midFreq') {
        const f = Math.min(6000, Math.max(200, value));
        this.eq.lowFrequency.rampTo(Math.max(40, f / 3), 0.03, time);
        this.eq.highFrequency.rampTo(Math.min(16000, f * 3), 0.03, time);
      }
      return;
    }
    if (param === 'makeup') return void this.makeup.gain.rampTo(dbToGain(value), 0.03, time);
    if (param === 'threshold' || param === 'ratio' || param === 'attack' || param === 'release') this.compParam(param, value, time);
  }

  /** A plugin effect of the chain, once loaded. */
  plugin(slotId: string): WamInstance | null {
    return this.plugins.get(slotId)?.instance ?? null;
  }

  /** Hear the chain (or one plugin) bypassed at matched loudness; null goes back to normal. Live only. */
  setCompare(c: { slotId: string | null; gainDb: number } | null) {
    this.compare = c;
    this.update(this.last);
  }

  /** Gain reduction of the compressor in dB (≤ 0), for the meter in the UI. */
  get reduction() {
    return this.cw ? this.cwReduction : this.comp.reduction;
  }

  dispose() {
    this.plugins.forEach((p) => p.dispose());
    this.amp.dispose();
    this.cw?.disconnect();
    [this.input, this.output, this.eq, this.comp, this.makeup, this.compareGain, this.hpf, this.key].forEach((n) => n.dispose());
  }
}
