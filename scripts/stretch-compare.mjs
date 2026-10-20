#!/usr/bin/env node
// Time-stretch comparison for docs/adr/0002-time-stretch.md (F23): three materials (a voice-like vowel,
// drums, a pad), stretched 0.8× and 1.25× and pitch-shifted ±3 semitones with OpenBand's WSOLA and
// phase vocoder, plus plain resampling for reference. Prints objective measures and writes WAVs to
// listen to:   node scripts/stretch-compare.mjs [out-dir]      (Node ≥ 23: runs the .ts module directly)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { wsola, phaseVocoder, resample, processChannel } = await import(path.join(root, 'src/audio/stretch.ts'));
const out = process.argv[2] ?? path.join(root, 'stretch-compare');
fs.mkdirSync(out, { recursive: true });
const SR = 44100;
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

// ---- materials
function voice(sec = 3) {
  // A sung "ah": a glottal sawtooth with vibrato through three formant resonators.
  const x = new Float32Array(sec * SR);
  let ph = 0;
  const formants = [700, 1220, 2600].map((f, i) => ({ f, bw: [80, 90, 120][i], y1: 0, y2: 0, g: [1, 0.5, 0.25][i] }));
  for (let i = 0; i < x.length; i++) {
    const f0 = 165 * (1 + 0.012 * Math.sin((2 * Math.PI * 5.5 * i) / SR));
    ph = (ph + f0 / SR) % 1;
    const src = 2 * ph - 1;
    let y = 0;
    for (const r of formants) {
      const R = Math.exp((-Math.PI * r.bw) / SR);
      const v = src * (1 - R) + 2 * R * Math.cos((2 * Math.PI * r.f) / SR) * r.y1 - R * R * r.y2;
      r.y2 = r.y1;
      r.y1 = v;
      y += v * r.g;
    }
    const env = Math.min(1, i / (0.05 * SR), (x.length - i) / (0.1 * SR));
    x[i] = 0.25 * y * env;
  }
  return x;
}
function drums(sec = 3, bpm = 120) {
  const x = new Float32Array(sec * SR);
  const beat = (60 / bpm) * SR;
  for (let b = 0; b * beat < x.length; b++) {
    const at = Math.round(b * beat);
    for (let i = 0; i < 0.25 * SR && at + i < x.length; i++) {
      const t = i / SR;
      if (b % 2 === 0) x[at + i] += 0.8 * Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9); // kick
      else x[at + i] += 0.5 * rnd() * Math.exp(-t * 25); // snare
    }
    for (let h = 0; h < 2; h++) {
      const at2 = Math.round(at + (h * beat) / 2);
      for (let i = 0; i < 0.05 * SR && at2 + i < x.length; i++) x[at2 + i] += 0.15 * rnd() * Math.exp((-i / SR) * 80); // hats
    }
  }
  return x;
}
function pad(sec = 3) {
  const x = new Float32Array(sec * SR);
  const notes = [220, 277.18, 329.63];
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (const f of notes) for (const d of [-0.004, 0.004]) s += ((((i * f * (1 + d)) / SR) % 1) * 2 - 1) / 6;
    x[i] = 0.4 * s * Math.min(1, i / (0.4 * SR), (x.length - i) / (0.4 * SR));
  }
  return x;
}

// ---- measures
const envelope = (x, ms = 2) => {
  const hop = Math.round((SR * ms) / 1000);
  const e = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let m = 0;
    for (let k = 0; k < hop; k++) m = Math.max(m, Math.abs(x[i + k]));
    e.push(m);
  }
  return e;
};
/** Mean of the 8 steepest envelope rises, relative to the original's (100% = transients kept). */
const sharpness = (y, x) => {
  const rise = (z) => {
    const e = envelope(z);
    const d = e.slice(1).map((v, i) => v - e[i]).sort((a, b) => b - a).slice(0, 8);
    return d.reduce((a, b) => a + b, 0) / d.length;
  };
  return (100 * rise(y)) / rise(x);
};
/** Largest jump in the first and last 5 ms (a click at the edges); reported relative to the original's. */
const edgeStep = (y) => {
  const n = Math.round(SR * 0.005);
  let m = 0;
  for (const [a, b] of [[1, n], [y.length - n, y.length]]) for (let i = a; i < b; i++) m = Math.max(m, Math.abs(y[i] - y[i - 1]));
  return m;
};
/** Fundamental from the autocorrelation peak in 80–500 Hz (middle second). */
const f0 = (y) => {
  const s = y.subarray(Math.floor(y.length / 2 - SR / 2), Math.floor(y.length / 2 + SR / 2));
  let best = 0;
  let bl = 0;
  for (let lag = Math.floor(SR / 500); lag < SR / 80; lag++) {
    let c = 0;
    for (let i = 0; i + lag < s.length; i += 2) c += s[i] * s[i + lag];
    if (c > best) (best = c), (bl = lag);
  }
  return SR / bl;
};

function wav(file, x) {
  const d = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) d.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(d.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, d]));
}

const materials = { voice: voice(), drums: drums(), pad: pad() };
const methods = {
  'WSOLA (OpenBand, stretch)': (x, f) => wsola(x, f, SR),
  'phase vocoder (OpenBand)': (x, f) => phaseVocoder(x, f, SR),
  'resample (tape speed)': (x, f) => resample(x, 1 / f),
};
const rows = [];
for (const [name, x] of Object.entries(materials)) {
  wav(path.join(out, `${name}-original.wav`), x);
  for (const f of [0.8, 1.25]) {
    for (const [m, fn] of Object.entries(methods)) {
      const t0 = performance.now();
      const y = fn(x, f);
      const ms = performance.now() - t0;
      wav(path.join(out, `${name}-x${f}-${m.split(' ')[0].toLowerCase()}.wav`), y);
      rows.push({ material: name, op: `stretch ×${f}`, method: m, sharp: sharpness(y, x), f0: name === 'drums' ? null : (f0(y) / f0(x) - 1) * 100, edge: edgeStep(y) / edgeStep(x), rt: ms / ((y.length / SR) * 1000) });
    }
  }
  for (const s of [3, -3]) {
    const t0 = performance.now();
    const y = processChannel(x, 1, s, SR);
    const ms = performance.now() - t0;
    wav(path.join(out, `${name}-pitch${s > 0 ? '+' : ''}${s}.wav`), y);
    rows.push({ material: name, op: `pitch ${s > 0 ? '+' : ''}${s} st`, method: 'phase vocoder + resample (OpenBand)', sharp: sharpness(y, x), f0: name === 'drums' ? null : (f0(y) / (f0(x) * Math.pow(2, s / 12)) - 1) * 100, edge: edgeStep(y) / edgeStep(x), rt: ms / ((y.length / SR) * 1000) });
  }
}
console.log('| material | operation | method | transients kept | pitch error | edge jump vs original | time / audio |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.material} | ${r.op} | ${r.method} | ${r.sharp.toFixed(0)}% | ${r.f0 === null ? '—' : `${r.f0 >= 0 ? '+' : ''}${r.f0.toFixed(2)}%`} | ${r.edge.toFixed(2)}× | ${(r.rt * 100).toFixed(1)}% |`);
console.log(`\nWAV files for listening: ${out}`);
