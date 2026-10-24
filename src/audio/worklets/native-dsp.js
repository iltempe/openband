// The test plugins of the in-process host (G8.1), plain JavaScript on purpose: the same code runs in
// the AudioWorklet (offline renders, inline) and on the page (live, behind the block bridge), and is
// imported by the tests. They stand in for native plugins until the real host (openband-plughost) runs:
// a pure latency (to test plugin delay compensation) and a gain.

export const TEST_PLUGINS = {
  'org.openband.test.latency': {
    name: 'Test latency',
    vendor: 'OpenBand',
    kind: 'effect',
    params: [{ id: 'latency', name: 'Latency', min: 0, max: 8192, default: 512, unit: 'samples', step: 1 }],
  },
  'org.openband.test.gain': {
    name: 'Test gain',
    vendor: 'OpenBand',
    kind: 'effect',
    params: [{ id: 'gain', name: 'Gain', min: -24, max: 24, default: 0, unit: 'dB' }],
  },
};

/** One instance of a test plugin: `latency` in samples, `process(inputs, outputs)` per block. */
export class TestPlugin {
  constructor(id, params = {}, channels = 2) {
    const def = TEST_PLUGINS[id];
    if (!def) throw new Error(`Unknown test plugin "${id}"`);
    this.id = id;
    this.params = {};
    for (const p of def.params) this.params[p.id] = params[p.id] ?? p.default;
    this.ch = channels;
    // The latency is fixed when the plugin is created, as with real plugins (a change restarts it).
    this.latency = id === 'org.openband.test.latency' ? Math.max(0, Math.round(this.params.latency)) : 0;
    this.line = [];
    for (let c = 0; c < channels; c++) this.line.push(new Float32Array(Math.max(1, this.latency)));
    this.pos = 0;
  }

  setParam(id, value) {
    if (id in this.params && id !== 'latency') this.params[id] = value;
  }

  process(inputs, outputs) {
    const n = outputs[0].length;
    if (this.id === 'org.openband.test.gain') {
      const g = Math.pow(10, this.params.gain / 20);
      for (let c = 0; c < outputs.length; c++) {
        const x = inputs[c] || inputs[0];
        for (let i = 0; i < n; i++) outputs[c][i] = x ? x[i] * g : 0;
      }
      return;
    }
    const L = this.latency;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < outputs.length; c++) {
        const x = inputs[c] || inputs[0];
        const v = x ? x[i] : 0;
        if (!L) {
          outputs[c][i] = v;
          continue;
        }
        const line = this.line[Math.min(c, this.ch - 1)];
        outputs[c][i] = line[this.pos];
        line[this.pos] = v;
      }
      if (L) this.pos = (this.pos + 1) % L;
    }
  }
}

/**
 * The worklet side of the block bridge: what goes in is sent to the host as numbered blocks, what comes
 * back is played `blocks` blocks later (a jitter buffer). A block that isn't back in time plays as
 * silence (counted), so the latency stays exactly blocks × 128 + the plugin's.
 */
export class JitterBuffer {
  constructor(blocks) {
    this.blocks = blocks;
    this.ready = new Map();
    this.n = 0;
    this.underruns = 0;
    /** How many blocks after it went out each block came back (the bridge's round trip, G8.8). */
    this.late = new Array(32).fill(0);
  }

  /** Store a block the host returned. */
  put(n, data) {
    const late = this.n - 1 - n;
    if (late >= 0) this.late[Math.min(31, late)]++;
    if (n >= this.n - this.blocks) this.ready.set(n, data);
  }

  /** The number of the block going out now, and what plays now (null: nothing yet / underrun). */
  next() {
    const out = this.n - this.blocks;
    const n = this.n++;
    if (out < 0) return { n, data: null };
    const data = this.ready.get(out) ?? null;
    this.ready.delete(out);
    if (!data) this.underruns++;
    return { n, data };
  }
}
