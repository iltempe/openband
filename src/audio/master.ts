// The master chain (G1): EQ (tilt, shelves, bands) → glue compressor → M/S width → true-peak limiter.
// The same class runs live (engine.ts) and in the offline render (render.ts), so what you hear is what
// you export. Stages that are off are taken out of the signal path. The limiter is an AudioWorklet
// (master-dsp.js); its latency (5 ms + 12 samples) is compensated exactly by the render.
import * as Tone from 'tone';
import type { MasterChain } from '../types';
import { masterWorkletSource } from './worklets/master.worklet';

export const defaultMaster = (): MasterChain => ({
  on: true,
  eq: { on: false, tilt: 0, low: 0, high: 0, bands: [] },
  glue: { on: false, threshold: -18, ratio: 2, attack: 0.03, release: 0.25, makeup: 1.5 },
  width: { on: false, amount: 1, monoBelowHz: 120 },
  limiter: { on: false, ceilingDbtp: -1, targetLufs: -14, release: 120 },
});

/** Loudness targets per platform (SPEC v0.6 G1). */
export const PLATFORM_TARGETS = {
  spotify: { lufs: -14, ceiling: -1 },
  apple: { lufs: -16, ceiling: -1 },
  youtube: { lufs: -14, ceiling: -1 },
  soundcloud: { lufs: -11, ceiling: -1 },
  club: { lufs: -8, ceiling: -1 },
  cd: { lufs: -9, ceiling: -0.5 },
} as const;
export type Platform = keyof typeof PLATFORM_TARGETS;

/** A partial chain merged over the current one (or the defaults). */
export function mergeMaster(cur: MasterChain | undefined, patch: Partial<{ [K in keyof MasterChain]: Partial<MasterChain[K]> }>): MasterChain {
  const base = cur ?? defaultMaster();
  return {
    on: patch.on ?? base.on,
    eq: { ...base.eq, ...patch.eq },
    glue: { ...base.glue, ...patch.glue },
    width: { ...base.width, ...patch.width },
    limiter: { ...base.limiter, ...patch.limiter },
  };
}

const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();
/** Register the limiter and sidechain processors in a context (once). False where worklets are missing. */
export function loadMasterWorklets(ctx: BaseAudioContext): Promise<boolean> {
  let p = loaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet
      ? ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([masterWorkletSource()], { type: 'application/javascript' }))).then(
          () => true,
          (e) => {
            console.warn('[openband] master worklets unavailable:', e);
            return false;
          },
        )
      : Promise.resolve(false);
    loaded.set(ctx, p);
  }
  return p;
}

/** Samples of latency the limiter adds at a sample rate (lookahead 5 ms + the interpolator's 12). */
export const limiterLatency = (sampleRate: number) => Math.max(32, Math.round(0.005 * sampleRate)) + 12;

const dbToGain = (db: number) => Math.pow(10, db / 20);

export class MasterChainNode {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private low = new Tone.Filter({ type: 'lowshelf', frequency: 100, gain: 0 });
  private high = new Tone.Filter({ type: 'highshelf', frequency: 8000, gain: 0 });
  private tiltLo = new Tone.Filter({ type: 'lowshelf', frequency: 300, gain: 0 });
  private tiltHi = new Tone.Filter({ type: 'highshelf', frequency: 3400, gain: 0 });
  private bands: Tone.Filter[] = [];
  private glue = new Tone.Compressor({ threshold: -18, ratio: 2, attack: 0.03, release: 0.25, knee: 6 });
  /** The glue compressor as the worklet compressor (same DSP live and offline); Tone's is the stand-in. */
  private glueW: AudioWorkletNode | null = null;
  private glueLoad: Promise<void> | null = null;
  private glueMakeup = new Tone.Gain(1);
  private split = new Tone.MidSideSplit();
  private merge = new Tone.MidSideMerge();
  private sideHp = new Tone.Filter({ type: 'highpass', frequency: 120, rolloff: -24 });
  private sideGain = new Tone.Gain(1);
  /** What enters the glue and the limiter, for chains linked to this one (stems, see link). */
  private glueTap = new Tone.Gain(1);
  private limTap = new Tone.Gain(1);
  private limiter: AudioWorkletNode | null = null;
  private limiterLoad: Promise<void> | null = null;
  private routing = '';
  private last?: MasterChain;
  /** Live gain reduction of the limiter (dB ≤ 0), for the meter. */
  reductionDb = 0;

  constructor() {
    this.glue.connect(this.glueMakeup);
    this.split.mid.connect(this.merge.mid);
    this.split.side.chain(this.sideHp, this.sideGain, this.merge.side);
  }

  /** Samples of latency in the path now (the limiter's, when it is in). */
  get latency() {
    return this.limiterIn ? limiterLatency(this.input.context.sampleRate) : 0;
  }
  private limiterIn = false;

  private wantsLimiter(m?: MasterChain) {
    return !!(m?.on && m.limiter.on);
  }

  /** Resolves once the limiter and the glue (if wanted) are in the path. */
  async ready() {
    if (this.wantsLimiter(this.last)) await this.ensureLimiter();
    if (this.last?.on && this.last.glue.on) await this.ensureGlue();
  }

  private ensureGlue(): Promise<void> {
    this.glueLoad ??= (async () => {
      const raw = this.input.context.rawContext as unknown as BaseAudioContext;
      if (!(await loadMasterWorklets(raw))) return;
      this.glueW = new AudioWorkletNode(raw, 'openband-comp', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      this.routing = '';
      this.update(this.last);
    })();
    return this.glueLoad;
  }

  private glueParam(name: 'threshold' | 'ratio' | 'attack' | 'release', value: number) {
    if (this.glueW) {
      const p = this.glueW.parameters.get(name)!;
      const at = this.input.context.currentTime;
      p.cancelScheduledValues(at);
      p.setValueAtTime(p.value, at);
      p.linearRampToValueAtTime(value, at + 0.03);
    } else this.glue[name].rampTo(value, 0.03);
  }

  private ensureLimiter(): Promise<void> {
    this.limiterLoad ??= (async () => {
      const raw = this.input.context.rawContext as unknown as BaseAudioContext;
      if (!(await loadMasterWorklets(raw))) return;
      const m = this.last?.limiter;
      this.limiter = new AudioWorkletNode(raw, 'openband-limiter', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { channels: 2, lookaheadMs: 5, ceilingDb: m?.ceilingDbtp ?? -1, releaseMs: m?.release ?? 120, inputGainDb: m?.inputGainDb ?? 0 },
      });
      this.limiter.port.onmessage = (e) => {
        if (typeof e.data?.reductionDb === 'number') this.reductionDb = e.data.reductionDb;
      };
      this.routing = '';
      this.update(this.last);
    })();
    return this.limiterLoad;
  }

  update(m?: MasterChain) {
    this.last = m;
    const on = !!m?.on;
    const eqOn = on && m!.eq.on;
    const glueOn = on && m!.glue.on;
    const widthOn = on && m!.width.on;
    const limOn = this.wantsLimiter(m) && !!this.limiter;
    if (this.wantsLimiter(m) && !this.limiter) void this.ensureLimiter();
    if (glueOn && !this.glueW) void this.ensureGlue();
    const glueNode: Tone.InputNode = this.glueW ?? this.glue;
    const bandCount = eqOn ? (m!.eq.bands ?? []).length : 0;
    while (this.bands.length < bandCount) this.bands.push(new Tone.Filter({ type: 'peaking', frequency: 1000, Q: 1, gain: 0 }));
    const routing = `${eqOn}${glueOn}${!!this.glueW}${widthOn}${limOn}${bandCount}`;
    if (routing !== this.routing) {
      this.routing = routing;
      this.input.disconnect();
      [this.low, this.high, this.tiltLo, this.tiltHi, ...this.bands, this.glueMakeup, this.merge, this.glueTap, this.limTap].forEach((n) => n.disconnect());
      if (this.limiter) this.limiter.disconnect();
      if (this.glueW) {
        this.glueW.disconnect();
        Tone.connect(this.glueW, this.glueMakeup);
      }
      const stages: { in: Tone.InputNode; out: Tone.ToneAudioNode | AudioNode }[] = [];
      if (eqOn) for (const f of [this.low, this.high, this.tiltLo, this.tiltHi, ...this.bands.slice(0, bandCount)]) stages.push({ in: f, out: f });
      if (glueOn) {
        stages.push({ in: this.glueTap, out: this.glueTap });
        stages.push({ in: glueNode, out: this.glueMakeup });
      }
      if (widthOn) stages.push({ in: this.split, out: this.merge });
      if (limOn) {
        stages.push({ in: this.limTap, out: this.limTap });
        stages.push({ in: this.limiter!, out: this.limiter! });
      }
      let from: Tone.ToneAudioNode | AudioNode = this.input;
      for (const st of stages) {
        Tone.connect(from as Tone.ToneAudioNode, st.in);
        from = st.out;
      }
      Tone.connect(from as Tone.ToneAudioNode, this.output);
      this.limiterIn = limOn;
    }
    if (!m) return;
    if (eqOn) {
      // Filter gains are in dB, unconverted: ramp them linearly (Tone's exponential ramp fails through 0 dB).
      this.low.gain.linearRampTo(m.eq.low, 0.03);
      this.high.gain.linearRampTo(m.eq.high, 0.03);
      // Tilt: dB per octave around 1 kHz, as two opposite shelves ~3.5 octaves apart.
      this.tiltLo.gain.linearRampTo(-m.eq.tilt * 1.75, 0.03);
      this.tiltHi.gain.linearRampTo(m.eq.tilt * 1.75, 0.03);
      (m.eq.bands ?? []).forEach((b, i) => {
        this.bands[i].frequency.rampTo(Math.min(18000, Math.max(30, b.hz)), 0.03);
        this.bands[i].Q.rampTo(Math.max(0.1, b.q), 0.03);
        this.bands[i].gain.linearRampTo(b.gain, 0.03);
      });
    }
    if (glueOn) {
      this.glueParam('threshold', m.glue.threshold);
      this.glueParam('ratio', Math.max(1, m.glue.ratio));
      this.glueParam('attack', m.glue.attack);
      this.glueParam('release', m.glue.release);
      this.glueMakeup.gain.rampTo(dbToGain(m.glue.makeup), 0.03);
    }
    if (widthOn) {
      this.sideGain.gain.rampTo(Math.max(0, Math.min(2, m.width.amount)), 0.03);
      this.sideHp.frequency.rampTo(Math.max(20, m.width.monoBelowHz), 0.03);
    }
    this.limiter?.port.postMessage({ on: limOn, ceilingDb: m.limiter.ceilingDbtp, releaseMs: m.limiter.release, inputGainDb: m.limiter.inputGainDb ?? 0 });
  }

  /**
   * Link this chain's glue and limiter to another chain's (offline, after both are ready and set the
   * same): their gains then follow what the other chain hears — the full mix — so stems through this
   * chain add up to the other chain's output. EQ and width are linear and need no link.
   */
  link(to: MasterChainNode) {
    if (this.glueW && to.glueW) Tone.connect(to.glueTap, this.glueW, 0, 1);
    if (this.limiter && to.limiter) Tone.connect(to.limTap, this.limiter, 0, 1);
  }

  dispose() {
    this.limiter?.disconnect();
    this.glueW?.disconnect();
    [this.input, this.output, this.glueTap, this.limTap, this.low, this.high, this.tiltLo, this.tiltHi, ...this.bands, this.glue, this.glueMakeup, this.split, this.merge, this.sideHp, this.sideGain].forEach((n) => n.dispose());
  }
}
