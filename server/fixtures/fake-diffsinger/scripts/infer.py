// A stand-in for DiffSinger's scripts/infer.py, in JavaScript (run as `node scripts/infer.py acoustic …`
// by the tests: the engine's "python" is node). It checks the .ds the way DiffSinger reads it, keeps a
// copy for the test (FAKE_DS_LOG), and "sings" each phrase as a sine following f0_seq from its offset.
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const opt = (n) => argv[argv.indexOf(n) + 1];
if (argv[0] !== 'acoustic') throw new Error('only acoustic');
const ds = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
if (process.env.FAKE_DS_LOG) fs.writeFileSync(process.env.FAKE_DS_LOG, JSON.stringify({ ds, args: argv }));
if (opt('--exp') !== 'it_test_voice') {
  console.error(`FileNotFoundError: experiment ${opt('--exp')} not found`);
  process.exit(1);
}
const sr = 44100;
let end = 0;
for (const [i, s] of ds.entries()) {
  const ph = s.ph_seq.split(' ');
  const dur = s.ph_dur.split(' ').map(Number);
  const num = s.ph_num.split(' ').map(Number);
  const notes = s.note_seq.split(' ');
  const nd = s.note_dur.split(' ').map(Number);
  const slur = s.note_slur.split(' ');
  const bad = (m) => {
    console.error(`AssertionError: segment ${i}: ${m}`);
    process.exit(1);
  };
  if (ph.length !== dur.length) bad('ph_seq and ph_dur differ in length');
  if (num.reduce((a, b) => a + b, 0) !== ph.length) bad('ph_num does not add up to ph_seq');
  if (notes.length !== nd.length || notes.length !== slur.length || notes.length !== num.length) bad('notes and ph_num differ');
  let k = 0;
  for (const [j, n] of num.entries()) {
    const sum = dur.slice(k, k + n).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - nd[j]) > 0.002) bad(`word ${j}: phonemes last ${sum}, the note ${nd[j]}`);
    k += n;
  }
  end = Math.max(end, s.offset + dur.reduce((a, b) => a + b, 0));
}
const out = new Float32Array(Math.ceil((end + 0.2) * sr));
for (const s of ds) {
  const f0 = s.f0_seq.split(' ').map(Number);
  const step = Number(s.f0_timestep);
  let phase = 0;
  const from = Math.round(s.offset * sr);
  for (let i = 0; i < f0.length * step * sr && from + i < out.length; i++) {
    phase += f0[Math.min(f0.length - 1, Math.floor(i / sr / step))] / sr;
    out[from + i] += 0.3 * Math.sin(2 * Math.PI * phase);
  }
}
const buf = Buffer.alloc(44 + out.length * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + out.length * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(out.length * 2, 40);
out.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
fs.writeFileSync(path.join(opt('--out'), `${opt('--title')}.wav`), buf);
