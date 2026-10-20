// The live loudness meter as an AudioWorklet processor: the DSP's source text (loudness-dsp.js, tested
// against the offline loudness.ts) wrapped into a processor module.
import dsp from './loudness-dsp.js?raw';

/** Module source for audioWorklet.addModule (a blob URL): posts a reading every 100 ms; 'reset' resets. */
export function loudnessWorkletSource(): string {
  return `${dsp.replace(/^export /m, '')}
class OpenBandLoudness extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.meter = new StreamingLoudness(sampleRate, options.processorOptions.k, 2);
    this.frames = 0;
    this.every = Math.round(sampleRate * 0.1);
    this.port.onmessage = (e) => { if (e.data === 'reset') this.meter.reset(); };
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      this.meter.push(input.length === 1 ? [input[0]] : input);
      this.frames += input[0].length;
      if (this.frames >= this.every) { this.frames = 0; this.port.postMessage(this.meter.read()); }
    }
    return true;
  }
}
registerProcessor('openband-loudness', OpenBandLoudness);`;
}
