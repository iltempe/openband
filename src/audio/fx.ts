// Per-track insert effects: amp sim → 3-band EQ → compressor. Units that are off are taken out
// of the signal path entirely, so a track without effects sounds exactly as before.
import * as Tone from 'tone';
import type { TrackFx } from '../types';

export const defaultFx = (): TrackFx => ({
  amp: { on: false, drive: 0.45, tone: 0.55, level: 0.7 },
  eq: { on: false, low: 0, mid: 0, high: 0, midFreq: 1000 },
  comp: { on: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.18, makeup: 4 },
});

/** Fill in any missing section, e.g. for projects saved before a parameter existed. */
export function normalizeFx(fx?: Partial<TrackFx>): TrackFx {
  const d = defaultFx();
  return { amp: { ...d.amp, ...fx?.amp }, eq: { ...d.eq, ...fx?.eq }, comp: { ...d.comp, ...fx?.comp } };
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
  set(p: TrackFx['amp']) {
    // Pre-gain drives the waveshaper harder; level compensates so drive doesn't just mean "louder".
    this.input.gain.rampTo(1 + p.drive * 24, 0.03);
    this.shaper.distortion = 0.15 + p.drive * 0.85;
    this.cab.frequency.rampTo(1400 * Math.pow(2, p.tone * 2.8), 0.03);
    this.output.gain.rampTo((p.level * 1.4) / (1 + p.drive * 2), 0.03);
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
  private makeup = new Tone.Gain(1);
  private routing = '';

  constructor() {
    this.comp.connect(this.makeup);
  }

  update(raw?: TrackFx) {
    const fx = normalizeFx(raw);
    const routing = `${fx.amp.on}${fx.eq.on}${fx.comp.on}`;
    if (routing !== this.routing) {
      this.routing = routing;
      this.input.disconnect();
      this.amp.output.disconnect();
      this.eq.disconnect();
      this.makeup.disconnect();
      const stages: { in: Tone.InputNode; out: Tone.ToneAudioNode }[] = [];
      if (fx.amp.on) stages.push({ in: this.amp.input, out: this.amp.output });
      if (fx.eq.on) stages.push({ in: this.eq, out: this.eq });
      if (fx.comp.on) stages.push({ in: this.comp, out: this.makeup });
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
    this.comp.threshold.rampTo(fx.comp.threshold, 0.03);
    this.comp.ratio.rampTo(fx.comp.ratio, 0.03);
    this.comp.attack.rampTo(fx.comp.attack, 0.03);
    this.comp.release.rampTo(fx.comp.release, 0.03);
    this.makeup.gain.rampTo(dbToGain(fx.comp.makeup), 0.03);
  }

  /** Gain reduction of the compressor in dB (≤ 0), for the meter in the UI. */
  get reduction() {
    return this.comp.reduction;
  }

  dispose() {
    this.amp.dispose();
    [this.input, this.output, this.eq, this.comp, this.makeup].forEach((n) => n.dispose());
  }
}
