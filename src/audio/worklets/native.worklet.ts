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
    // The host's port (desktop app): blocks go there instead of to the page. Until it arrives, and for
    // the in-process host, they go to the page through this.port.
    this.transport = null;
    this.crashed = false;
    this.pluginLatency = 0;
    // Blocks missing in a row: a host that stops answering (crashed, hung) is treated as crashed.
    this.missing = 0;
    this.answered = false;
    // The last inputs, to play the track bypassed with the same latency if the plugin crashes.
    this.ring = [];
    for (let c = 0; c < this.channels; c++) this.ring.push(new Float32Array(65536));
    this.w = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'block') this.jitter && this.jitter.put(m.n, m.data);
      else if (m.type === 'param') {
        if (this.plugin) this.plugin.setParam(m.id, m.value);
        else if (this.transport) this.transport.postMessage(m);
      }
      else if (m.type === 'transport') {
        this.transport = e.ports[0];
        this.pluginLatency = m.pluginLatency || 0;
        this.crashed = false;
        this.missing = 0;
        this.answered = false;
        this.transport.onmessage = (ev) => this.fromHost(ev.data);
      }
    };
  }
  fromHost(m) {
    if (m.type === 'block') this.jitter.put(m.n, m.data);
    else if (m.type === 'crashed') {
      this.crashed = true;
      this.port.postMessage({ type: 'crashed', reason: m.reason });
    } else if (m.type === 'latency') this.port.postMessage({ type: 'latency', latency: m.latency });
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
    const mask = 65535;
    for (let c = 0; c < this.channels; c++) for (let i = 0; i < n; i++) this.ring[c][(this.w + i) & mask] = block[c][i];
    const { n: seq, data } = this.jitter.next();
    if (this.crashed) {
      // Bypassed, as late as the plugin was: the track stays in time with the others.
      const lat = this.jitter.blocks * n + this.pluginLatency;
      for (let c = 0; c < output.length; c++) {
        const r = this.ring[Math.min(c, this.channels - 1)];
        for (let i = 0; i < n; i++) output[c][i] = r[(this.w + i - lat) & mask];
      }
    } else {
      // The desktop app's port (Electron's MessagePortMain) doesn't take transferred buffers: copy there.
      if (this.transport) this.transport.postMessage({ type: 'block', n: seq, data: block });
      else this.port.postMessage({ type: 'block', n: seq, data: block }, block.map((b) => b.buffer));
      for (let c = 0; c < output.length; c++) {
        const src = data ? data[Math.min(c, data.length - 1)] : null;
        if (src) output[c].set(src.subarray(0, n));
        else output[c].fill(0);
      }
      if (data) {
        this.answered = true;
        this.missing = 0;
      } else if (this.transport && this.answered && ++this.missing > 2 * this.jitter.blocks) {
        this.crashed = true;
        this.port.postMessage({ type: 'crashed', reason: 'stopped answering' });
      }
    }
    this.w = (this.w + n) & mask;
    this.frames += n;
    if (this.frames >= 48000) { this.frames = 0; this.port.postMessage({ type: 'stats', underruns: this.jitter.underruns }); }
    return true;
  }
}
registerProcessor('openband-native', OpenBandNative);`;
}
