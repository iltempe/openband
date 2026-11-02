// The Box's gate, in a worker, for "Record the rehearsal" in the browser.
import { Gate } from '../../server/box/gate.mjs';

let gate: Gate | null = null;
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') gate = new Gate({ sampleRate: m.sampleRate, channels: m.channels, preRollS: m.preRollS });
  else if (m.type === 'pcm' && gate) for (const event of gate.push(m.data)) self.postMessage(event);
  else if (m.type === 'force' && gate) {
    const event = gate.force(m.on);
    if (event) self.postMessage(event);
  }
};
