// The NativePluginNode's processor (G8): a native plugin in the Web Audio graph. Live, each 128-frame block
// goes to the plugin host and comes back through a jitter buffer; offline (and for the in-process test
// plugins) the plugin runs here, inline. The DSP is native-dsp.js, shared with the tests and the page.
import dsp from './native-dsp.js?raw';

export function nativeWorkletSource(): string {
  return `${dsp.replace(/^export /gm, '')}
class OpenBandNative extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.mode = o.mode || 'inline';
    this.channels = o.channels || 2;
    if (this.mode === 'inline') this.plugin = new TestPlugin(o.plugin.id, o.plugin.params || {}, this.channels);
    else this.jitter = new JitterBuffer(o.jitterBlocks || 6);
    this.frames = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'block') this.jitter && this.jitter.put(m.n, m.data);
      else if (m.type === 'param' && this.plugin) this.plugin.setParam(m.id, m.value);
    };
  }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0].length ? inputs[0] : null;
    const output = outputs[0];
    const n = output[0].length;
    if (this.mode === 'inline') {
      this.plugin.process(input || [new Float32Array(n)], output);
      return true;
    }
    const block = [];
    for (let c = 0; c < this.channels; c++) block.push(input ? Float32Array.from(input[Math.min(c, input.length - 1)]) : new Float32Array(n));
    const { n: seq, data } = this.jitter.next();
    this.port.postMessage({ type: 'block', n: seq, data: block }, block.map((b) => b.buffer));
    for (let c = 0; c < output.length; c++) {
      const src = data ? data[Math.min(c, data.length - 1)] : null;
      if (src) output[c].set(src.subarray(0, n));
      else output[c].fill(0);
    }
    this.frames += n;
    if (this.frames >= 48000) { this.frames = 0; this.port.postMessage({ type: 'stats', underruns: this.jitter.underruns }); }
    return true;
  }
}
registerProcessor('openband-native', OpenBandNative);`;
}
