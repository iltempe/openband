// The transitions of an arrangement (G2), synthesized here: no samples, no network. Seeded noise through
// filters, so the same transition always sounds the same. Mono, −1..1; the app stores them as samples.
//   riser           noise through a band-pass sweeping up, getting louder, with a rising tone
//   downlifter      the riser backwards: down and fading
//   reverse_cymbal  a cymbal-like burst (high-passed noise, long decay), played backwards into the beat
//   impact          a low boom (a sine falling from 90 to 35 Hz) with a short noise hit
import type { TransitionKind } from './arrange';

function noise(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    return ((a >>> 0) / 4294967296) * 2 - 1;
  };
}

/** A band-pass biquad (RBJ), retuned per sample. */
function bandpass(sr: number) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x: number, freq: number, q: number) => {
    const w = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const b0 = alpha, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * Math.cos(w), a2 = 1 - alpha;
    const y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

export function synthTransition(kind: Exclude<TransitionKind, 'fill' | 'stop'>, seconds: number, sampleRate = 48000): Float32Array {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  const rnd = noise(0x5eed + kind.length * 977);
  if (kind === 'riser' || kind === 'downlifter') {
    const bp = bandpass(sampleRate);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = kind === 'riser' ? i / n : 1 - i / n; // 0 → 1 up the sweep
      const f = 200 * Math.pow(40, t); // 200 Hz → 8 kHz
      const env = Math.pow(t, 1.6) * (kind === 'downlifter' ? Math.min(1, (i / n) * 40) : 1);
      phase += (2 * Math.PI * (110 * Math.pow(4, t))) / sampleRate;
      out[i] = (bp(rnd(), f, 2.5) * 2.2 + Math.sin(phase) * 0.18) * env;
    }
  } else if (kind === 'reverse_cymbal') {
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const x = rnd();
      const hp = x - prev; // a simple high-pass: cymbal-like hiss
      prev = x;
      const t = (n - 1 - i) / sampleRate; // played backwards: the decay grows into the beat
      out[i] = hp * 0.5 * Math.exp(-t * 2.2);
    }
  } else {
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const f = 35 + 55 * Math.exp(-t * 6);
      phase += (2 * Math.PI * f) / sampleRate;
      const boom = Math.sin(phase) * Math.exp(-t * 2.5);
      const hit = rnd() * Math.exp(-t * 40) * 0.6;
      out[i] = (boom + hit) * 0.9;
    }
  }
  // Leave headroom: peaks at −3 dBFS.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= 0.708 / peak;
  return out;
}
