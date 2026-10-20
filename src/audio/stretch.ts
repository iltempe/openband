// Time-stretch and pitch-shift of audio clips (F23), written for OpenBand (no GPL code, no dependency).
// Pure and synchronous: it runs in a worker (workers/stretch.worker.ts) and in the Node tests.
//   - stretch only: WSOLA (waveform-similarity overlap-add) — keeps transients and voices clean;
//   - pitch (with or without stretch): phase vocoder with identity phase locking, then resampling.
// Rubber Band is GPL and is deliberately not used; see docs/adr/0002-time-stretch.md.

/** Output length / input length for a clip (1 = untouched). */
export function stretchFactor(clip: { stretch?: { mode: 'off' | 'follow_tempo' | 'fixed'; ratio?: number; originalBpm?: number } }, projectBpm: number): number {
  const s = clip.stretch;
  if (!s || s.mode === 'off') return 1;
  if (s.mode === 'fixed') return s.ratio && s.ratio > 0 ? s.ratio : 1;
  return s.originalBpm && s.originalBpm > 0 ? s.originalBpm / projectBpm : 1;
}

const hann = (n: number) => Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));

/**
^ * WSOLA: output = `factor` × input length. Frames (~23 ms) are taken near where they should
 * come from, shifted (±tolerance) to best continue the previous frame's waveform, and overlap-added.
 */
export function wsola(x: Float32Array, factor: number, sampleRate: number): Float32Array {
  if (Math.abs(factor - 1) < 1e-6) return x.slice();
  const N = Math.max(256, 1 << Math.round(Math.log2(sampleRate * 0.025))); // ~23 ms at 44.1 kHz
  const Hs = N / 2;
  const tol = N / 4;
  const win = hann(N);
  const outLen = Math.round(x.length * factor);
  const y = new Float32Array(outLen + N);
  const norm = new Float32Array(outLen + N);
  const at = (i: number) => (i >= 0 && i < x.length ? x[i] : 0);
  // Attacks: where the energy of 2.5 ms blocks jumps (×8 over the 20 ms before). Inside a frame the
  // material plays at its own speed, so an attack d samples into a frame would land d·(1 − factor) off
  // its stretched time; frames that contain one are placed so that it lands exactly on time.
  const B = Math.max(32, Math.round(sampleRate * 0.0025));
  const blockE: number[] = [];
  for (let i = 0; i < x.length; i += B) {
    let e = 0;
    for (let k = 0; k < B && i + k < x.length; k++) e += x[i + k] * x[i + k];
    blockE.push(e / B);
  }
  const onsets: number[] = [];
  const back = Math.round((sampleRate * 0.02) / B);
  for (let b = back; b < blockE.length; b++) {
    let before = 0;
    for (let k = b - back; k < b; k++) before += blockE[k];
    before /= back;
    if (blockE[b] > 1e-6 && blockE[b] > 8 * before && (!onsets.length || b * B - onsets[onsets.length - 1] > 0.03 * sampleRate)) onsets.push(b * B);
  }
  /** An attack inside [start, start + N), if any. */
  const onsetIn = (start: number) => onsets.find((t) => t >= start && t < start + N);
  let prevStart = 0;
  for (let o = 0, k = 0; o < outLen; o += Hs, k++) {
    const ideal = Math.round(o / factor);
    let best = ideal;
    const att = onsetIn(ideal - N / 4);
    if (att !== undefined) best = att - (Math.round(att * factor) - o);
    else if (k > 0) {
      // The natural continuation of the previous frame, Hs samples later.
      const target = prevStart + Hs;
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const cand = ideal + d;
        let s = 0;
        for (let i = 0; i < N / 2; i += 4) s += at(cand + i) * at(target + i);
        if (s > bestScore) {
          bestScore = s;
          best = cand;
        }
      }
    }
    for (let i = 0; i < N; i++) {
      y[o + i] += at(best + i) * win[i];
      norm[o + i] += win[i];
    }
    prevStart = best;
  }
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = norm[i] > 1e-3 ? y[i] / norm[i] : y[i];
  return edgeFades(out, sampleRate);
}

/** 3 ms fades so a processed clip never starts or ends on a step. */
function edgeFades(x: Float32Array, sampleRate: number): Float32Array {
  const n = Math.min(Math.floor(x.length / 2), Math.round(sampleRate * 0.003));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
  return x;
}

// ---------------------------------------------------------------- FFT (radix-2, in place)

function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

/**
 * Phase vocoder time-stretch with identity phase locking (Laroche–Dolson): each bin keeps its phase
 * relation to the nearest spectral peak, which avoids the "phasey" sound of a plain vocoder.
 */
export function phaseVocoder(x: Float32Array, factor: number, sampleRate: number): Float32Array {
  const N = Math.max(512, 1 << Math.round(Math.log2(sampleRate * 0.046))); // ~46 ms
  const Hs = N / 4;
  const Ha = Hs / factor;
  const win = hann(N);
  const bins = N / 2 + 1;
  const outLen = Math.round(x.length * factor);
  const y = new Float32Array(outLen + N);
  const norm = new Float32Array(outLen + N);
  const prevPhase = new Float64Array(bins);
  const synth = new Float64Array(bins);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(bins);
  const phase = new Float64Array(bins);
  const outPhase = new Float64Array(bins);
  const omega = Float64Array.from({ length: bins }, (_, k) => (2 * Math.PI * k) / N);
  const at = (i: number) => (i >= 0 && i < x.length ? x[i] : 0);
  const wrap = (v: number) => v - 2 * Math.PI * Math.round(v / (2 * Math.PI));
  let prevA = 0;
  for (let t = 0, o = 0; o < outLen; t++, o = Math.round(t * Hs)) {
    const a = Math.round(t * Ha) - N / 2;
    const hopA = a - prevA;
    prevA = a;
    for (let i = 0; i < N; i++) {
      re[i] = at(a + i) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }
    if (t === 0) {
      for (let k = 0; k < bins; k++) outPhase[k] = phase[k];
    } else {
      // Peaks get their true frequency from the phase advance; every other bin follows its nearest peak.
      const peaks: number[] = [];
      for (let k = 1; k < bins - 1; k++) if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) peaks.push(k);
      for (const p of peaks) {
        const freq = omega[p] + (hopA > 0 ? wrap(phase[p] - prevPhase[p] - omega[p] * hopA) / hopA : 0);
        outPhase[p] = synth[p] + freq * Hs;
      }
      let pi = 0;
      for (let k = 0; k < bins; k++) {
        if (!peaks.length) {
          outPhase[k] = synth[k] + omega[k] * Hs;
          continue;
        }
        while (pi + 1 < peaks.length && Math.abs(peaks[pi + 1] - k) <= Math.abs(peaks[pi] - k)) pi++;
        const p = peaks[pi];
        if (k !== p) outPhase[k] = outPhase[p] + (phase[k] - phase[p]);
      }
    }
    for (let k = 0; k < bins; k++) {
      prevPhase[k] = phase[k];
      synth[k] = outPhase[k];
    }
    for (let k = 0; k < bins; k++) {
      re[k] = mag[k] * Math.cos(outPhase[k]);
      im[k] = mag[k] * Math.sin(outPhase[k]);
      if (k > 0 && k < N / 2) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }
    fft(re, im, true);
    const start = o - N / 2;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      if (j < 0 || j >= y.length) continue;
      y[j] += re[i] * win[i];
      norm[j] += win[i] * win[i];
    }
  }
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = norm[i] > 1e-3 ? y[i] / norm[i] : 0;
  return out;
}

/** Resample by `rate` (output length = input / rate), cubic interpolation. */
export function resample(x: Float32Array, rate: number): Float32Array {
  const n = Math.max(1, Math.round(x.length / rate));
  const out = new Float32Array(n);
  const at = (i: number) => x[Math.min(x.length - 1, Math.max(0, i))];
  for (let i = 0; i < n; i++) {
    const p = i * rate;
    const k = Math.floor(p);
    const f = p - k;
    const y0 = at(k - 1);
    const y1 = at(k);
    const y2 = at(k + 1);
    const y3 = at(k + 2);
    out[i] = y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
  }
  return out;
}

/** Stretch by `factor` and shift by `semitones` (cents as decimals), one channel. */
export function processChannel(x: Float32Array, factor: number, semitones: number, sampleRate: number): Float32Array {
  if (Math.abs(semitones) < 1e-3) return wsola(x, factor, sampleRate);
  const shift = Math.pow(2, semitones / 12);
  // Stretch by factor × shift, then play it `shift` times faster: same length, pitch moved.
  const stretched = phaseVocoder(x, factor * shift, sampleRate);
  return edgeFades(resample(stretched, shift).subarray(0, Math.round(x.length * factor)).slice(), sampleRate);
}

// ---------------------------------------------------------------- tempo detection

/** "drumloop_92bpm.wav", "Funk 120 BPM.wav" → 92 / 120. */
export function bpmFromName(name: string): number | null {
  const m = name.match(/(?:^|[^\d])(\d{2,3}(?:\.\d+)?)\s*-?\s*bpm/i) ?? name.match(/bpm\s*-?\s*(\d{2,3}(?:\.\d+)?)/i);
  const v = m ? Number(m[1]) : NaN;
  return v >= 40 && v <= 240 ? v : null;
}

/**
 * Tempo of a loop: an onset-strength envelope (rectified energy increase, 10 ms hops), its
 * autocorrelation over 60–180 BPM, then the BPM that makes the clip a whole number of bars when that
 * is close.
 */
export function detectTempo(x: Float32Array, sampleRate: number, name = ''): { bpm: number; confidence: number; source: 'name' | 'audio' } {
  const fromName = bpmFromName(name);
  if (fromName) return { bpm: fromName, confidence: 1, source: 'name' };
  const hop = Math.round(sampleRate * 0.01);
  const env: number[] = [];
  let prev = 0;
  for (let i = 0; i + hop <= x.length; i += hop) {
    let e = 0;
    for (let k = 0; k < hop; k++) e += x[i + k] * x[i + k];
    e = Math.sqrt(e / hop);
    env.push(Math.max(0, e - prev));
    prev = e;
  }
  const mean = env.reduce((a, b) => a + b, 0) / (env.length || 1);
  const z = env.map((v) => v - mean);
  const score = (bpm: number) => {
    const lag = (60 / bpm) * 100; // in 10 ms hops
    let s = 0;
    for (let i = 0; i + lag + 1 < z.length; i++) {
      const j = i + lag;
      const f = j - Math.floor(j);
      s += z[i] * (z[Math.floor(j)] * (1 - f) + z[Math.floor(j) + 1] * f);
    }
    return s;
  };
  let best = 120;
  let bestS = -Infinity;
  let total = 0;
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const s = score(bpm) + 0.5 * score(bpm * 2 <= 240 ? bpm * 2 : bpm);
    total += Math.max(0, s);
    if (s > bestS) {
      bestS = s;
      best = bpm;
    }
  }
  // Loops are usually a whole number of bars: snap when that is within 2%.
  const seconds = x.length / sampleRate;
  for (const bars of [1, 2, 4, 8, 16]) {
    const exact = (bars * 4 * 60) / seconds;
    if (Math.abs(exact - best) / best < 0.02) {
      best = exact;
      break;
    }
  }
  const confidence = total > 0 ? Math.min(1, (bestS / total) * 30) : 0;
  return { bpm: +best.toFixed(2), confidence: +confidence.toFixed(2), source: 'audio' };
}
