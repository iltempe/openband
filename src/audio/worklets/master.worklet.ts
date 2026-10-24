// The master limiter and the sidechain ducker as AudioWorklet processors: the DSP's source text
// (master-dsp.js, tested directly) wrapped into a processor module.
import dsp from './master-dsp.js?raw';

/** Module source for audioWorklet.addModule (a blob URL). Settings arrive as port messages. */
export function masterWorkletSource(): string {
  return `${dsp.replace(/^export /gm, '')}
class OpenBandLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.dsp = new TruePeakLimiter(sampleRate, options.processorOptions || {});
    this.frames = 0;
    this.port.onmessage = (e) => this.dsp.set(e.data);
    this.port.postMessage({ latency: this.dsp.latency });
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    this.dsp.process(input && input.length ? input : [new Float32Array(output[0].length)], output);
    this.frames += output[0].length;
    if (this.frames >= 4800) { this.frames = 0; this.port.postMessage({ reductionDb: this.dsp.reductionDb }); }
    return true;
  }
}
registerProcessor('openband-limiter', OpenBandLimiter);
class OpenBandComp extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 40, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.01, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.18, minValue: 0.001, maxValue: 3, automationRate: 'k-rate' },
      { name: 'amount', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.dsp = new Compressor(sampleRate);
    this.frames = 0;
    this.port.onmessage = (e) => this.dsp.set(e.data);
  }
  process(inputs, outputs, params) {
    const n = outputs[0][0].length;
    const d = this.dsp;
    const t = params.threshold[0], r = params.ratio[0], a = params.attack[0], rl = params.release[0], am = params.amount[0];
    if (t !== this.t || r !== this.r || a !== this.a || rl !== this.rl || am !== this.am) {
      d.set({ threshold: t, ratio: r, attack: a, release: rl, amount: am });
      this.t = t; this.r = r; this.a = a; this.rl = rl; this.am = am;
    }
    const sig = inputs[0] && inputs[0].length ? inputs[0] : [new Float32Array(n)];
    // Input 1 is the sidechain key; unconnected (no channels), the signal keys itself.
    const key = inputs[1] && inputs[1].length ? inputs[1] : null;
    this.dsp.process(sig, key, outputs[0]);
    this.frames += n;
    if (this.frames >= 2400) { this.frames = 0; this.port.postMessage({ reductionDb: this.dsp.grDb }); }
    return true;
  }
}
registerProcessor('openband-comp', OpenBandComp);
class OpenBandCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.total = options.processorOptions.frames;
    this.got = 0;
    this.started = -1;
    this.l = new Float32Array(this.total);
    this.r = new Float32Array(this.total);
  }
  process(inputs, outputs) {
    const input = inputs[0];
    if (this.got >= this.total) return false;
    const n = outputs[0][0].length;
    if (this.started < 0) this.started = currentTime;
    const a = input && input[0] ? input[0] : null;
    const b = input && input[1] ? input[1] : a;
    const k = Math.min(n, this.total - this.got);
    if (a) { this.l.set(a.subarray(0, k), this.got); this.r.set(b.subarray(0, k), this.got); }
    this.got += k;
    if (this.got >= this.total) this.port.postMessage({ l: this.l, r: this.r, startTime: this.started }, [this.l.buffer, this.r.buffer]);
    return this.got < this.total;
  }
}
registerProcessor('openband-capture', OpenBandCapture);`;
}
