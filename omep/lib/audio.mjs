// WAV in and out, and the measurements conformance needs: duration, tempo, key. Plain JS, no dependencies.
import { parseKey, keyName } from './music.mjs';

/** 16-bit PCM WAV of mono or stereo Float32 channels. */
export function encodeWav(channels, sampleRate) {
  const n = channels[0].length;
  const ch = channels.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * ch * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  return buf;
}

/** PCM 16/24/32-bit or float32 WAV → { sampleRate, channels: Float32Array[] }. */
export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let p = 12;
  let fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), sampleRate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') {
      if (!fmt) throw new Error('WAV without fmt chunk');
      const bytes = fmt.bits / 8;
      const frames = Math.floor(Math.min(size, buf.length - p - 8) / (bytes * fmt.channels));
      const out = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      let o = p + 8;
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < fmt.channels; c++) {
          let v;
          if (fmt.format === 3) v = buf.readFloatLE(o);
          else if (fmt.bits === 16) v = buf.readInt16LE(o) / 32768;
          else if (fmt.bits === 24) v = buf.readIntLE(o, 3) / 8388608;
          else v = buf.readInt32LE(o) / 2147483648;
          out[c][i] = v;
          o += bytes;
        }
      return { sampleRate: fmt.sampleRate, channels: out };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error('WAV without data chunk');
}

const mono = (channels) => {
  if (channels.length === 1) return channels[0];
  const m = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < m.length; i++) m[i] += c[i] / channels.length;
  return m;
};

/** Onset-strength envelope (positive energy flux) at a hop of ~10 ms. */
function onsetEnvelope(x, sr) {
  const hop = Math.round(sr / 100);
  const env = [];
  let prev = 0;
  for (let i = 0; i + hop <= x.length; i += hop) {
    let e = 0;
    for (let k = 0; k < hop; k++) e += x[i + k] * x[i + k];
    e = Math.sqrt(e / hop);
    env.push(Math.max(0, e - prev));
    prev = e;
  }
  return { env, hop };
}

/** Tempo in BPM from the autocorrelation of the onset envelope (60–200 BPM, folded into it). */
export function estimateBpm(channels, sr) {
  const x = mono(channels);
  const { env, hop } = onsetEnvelope(x, sr);
  const fps = sr / hop;
  const mean = env.reduce((a, b) => a + b, 0) / (env.length || 1);
  const e = env.map((v) => v - mean);
  let best = { bpm: 0, score: -Infinity };
  for (let bpm = 60; bpm <= 200; bpm += 0.25) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (let i = 0; i + 2 * lag < e.length; i++) {
      const a = e[i];
      const l1 = Math.round(i + lag);
      const l2 = Math.round(i + 2 * lag);
      s += a * (e[l1] + 0.5 * e[l2]);
    }
    if (s > best.score) best = { bpm, score: s };
  }
  return best.bpm;
}

// Krumhansl–Kessler key profiles.
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const corr = (a, b) => {
  const ma = a.reduce((s, v) => s + v, 0) / 12;
  const mb = b.reduce((s, v) => s + v, 0) / 12;
  let n = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db || 1);
};

/** Key from a 12-bin chroma profile. */
export function keyFromChroma(chroma) {
  let best = { key: 'C', r: -Infinity };
  for (let t = 0; t < 12; t++) {
    const rot = (p) => Array.from({ length: 12 }, (_, i) => p[(i - t + 12) % 12]);
    for (const [minor, prof] of [
      [false, MAJ],
      [true, MIN],
    ]) {
      const r = corr(chroma, rot(prof));
      if (r > best.r) best = { key: keyName({ tonic: t, minor }), r };
    }
  }
  return best.key;
}

/** Key of audio: chroma from Goertzel filters on equal-tempered pitches C2–B6. */
export function estimateKey(channels, sr) {
  const x = mono(channels);
  const chroma = new Array(12).fill(0);
  const win = 4096;
  const step = Math.max(win, Math.floor(x.length / 60)); // at most ~60 frames
  for (let start = 0; start + win <= x.length; start += step) {
    for (let midi = 36; midi < 96; midi++) {
      const f = 440 * 2 ** ((midi - 69) / 12);
      const w = (2 * Math.PI * f) / sr;
      const c = 2 * Math.cos(w);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < win; i++) {
        const s0 = x[start + i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      chroma[midi % 12] += Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
    }
  }
  return keyFromChroma(chroma);
}

/** Key of notes: duration-weighted pitch-class profile. */
export function keyOfNotes(notes) {
  const chroma = new Array(12).fill(0);
  for (const n of notes) chroma[n.pitch % 12] += n.duration;
  return keyFromChroma(chroma);
}

export { parseKey };
