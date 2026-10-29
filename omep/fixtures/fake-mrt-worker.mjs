#!/usr/bin/env node
// A stand-in for omep/magenta_rt_worker.py speaking its stdio protocol, for tests without the model: each
// frame is a click when the conditioning puts a drum onset in it, a quiet tone of the chord's lowest note
// otherwise. `--fail` reports a missing model; `--slow <ms>` takes that long per frame.
const fail = process.argv.includes('--fail');
const i = process.argv.indexOf('--slow');
const slow = i > 0 ? Number(process.argv[i + 1]) : 0;
const send = (kind, payload) => {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(payload.length + 1, 0);
  head[4] = kind;
  process.stdout.write(Buffer.concat([head, payload]));
};
const json = (o) => send(0, Buffer.from(JSON.stringify(o)));
if (fail) {
  json({ error: 'FileNotFoundError: models/mrt2_small/mrt2_small.mlxfn. Install magenta-rt and run `mrt models init`.' });
  process.exit(1);
}
json({ ready: true, model: 'fake', backend: 'none', sample_rate: 48000, frame_samples: 1920 });
let phase = 0;
let buf = '';
process.stdin.on('data', async (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.op === 'style') {
      json({ id: msg.id });
      continue;
    }
    if (slow) await new Promise((ok) => setTimeout(ok, slow));
    const out = Buffer.alloc(4 + msg.frames.length * 1920 * 2 * 4);
    out.writeUInt32LE(msg.id, 0);
    msg.frames.forEach((f, k) => {
      const low = f.notes ? f.notes.findIndex((v) => v > 0) : 57;
      const hz = 440 * 2 ** ((low - 69) / 12);
      for (let s = 0; s < 1920; s++) {
        const v = f.drums === 1 && s < 96 ? 0.8 * (1 - s / 96) : 0.05 * Math.sin(phase);
        phase += (2 * Math.PI * hz) / 48000;
        out.writeFloatLE(v, 4 + (k * 1920 + s) * 8);
        out.writeFloatLE(v, 4 + (k * 1920 + s) * 8 + 4);
      }
    });
    send(1, out);
  }
});
