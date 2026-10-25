// OpenBand's guide voice (voice.sing, SPEC v0.6 §10): it sings the melody on the lyrics' phonemes with a
// small formant synthesizer — a glottal pulse at the note's pitch with vibrato, three vowel resonances
// gliding from one vowel to the next, noise for fricatives, a stop and a burst for plosives, a murmur for
// nasals and liquids. Not a singer: a guide vocal to hear a topline with its words, instantly and offline,
// before a real voice (or DiffSinger) sings it. Pure: samples in, samples out.

export interface SungSyllable {
  text: string;
  /** Seconds from the start of the rendered audio. */
  start: number;
  end: number;
  midi: number;
  phonemes: string[];
}

/** F1–F3 (Hz) of the vowels, an average adult voice; bandwidths grow with the formant. */
const FORMANTS: Record<string, [number, number, number]> = {
  a: [800, 1200, 2700],
  e: [420, 2050, 2650],
  E: [570, 1800, 2600],
  i: [290, 2300, 3000],
  o: [460, 820, 2600],
  O: [580, 900, 2550],
  u: [330, 720, 2400],
  // glides, nasals, liquids: close to a vowel, quieter
  j: [300, 2200, 2950],
  w: [330, 700, 2400],
  m: [280, 1100, 2400],
  n: [280, 1600, 2500],
  J: [300, 2000, 2700],
  l: [380, 1300, 2600],
  L: [320, 2000, 2700],
  r: [480, 1350, 1700],
};
const VOWELS = new Set(['a', 'e', 'E', 'i', 'o', 'O', 'u']);
const SONORANT_GAIN: Record<string, number> = { j: 0.6, w: 0.6, m: 0.3, n: 0.3, J: 0.35, l: 0.5, L: 0.45, r: 0.55 };
/** How long a consonant lasts (s). */
const CONSONANT_S: Record<string, number> = { s: 0.09, z: 0.08, S: 0.1, f: 0.08, v: 0.06, ts: 0.09, dz: 0.08, tS: 0.1, dZ: 0.09, p: 0.07, t: 0.065, k: 0.075, b: 0.06, d: 0.055, g: 0.065, r: 0.05 };
const UNVOICED = new Set(['s', 'S', 'f', 'p', 't', 'k', 'ts', 'tS']);
const PLOSIVE = new Set(['p', 't', 'k', 'b', 'd', 'g']);
/** Where the noise of a fricative or burst sits: [low, high] Hz, gain. */
const NOISE: Record<string, [number, number, number]> = {
  s: [4500, 9000, 0.22], z: [4500, 9000, 0.12], S: [2300, 5000, 0.25], f: [1500, 7000, 0.08], v: [1500, 6000, 0.05],
  ts: [4000, 9000, 0.22], dz: [4000, 9000, 0.12], tS: [2300, 5000, 0.25], dZ: [2300, 5000, 0.14],
  p: [500, 3000, 0.25], t: [3000, 7000, 0.25], k: [1500, 4000, 0.25], b: [500, 2500, 0.14], d: [2500, 6000, 0.14], g: [1200, 3500, 0.14],
};

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A band-pass biquad (constant skirt gain), as coefficients. */
function bandpass(f: number, bw: number, sr: number) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const q = Math.max(0.5, f / bw);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
}

interface Seg {
  ph: string;
  from: number;
  to: number;
  midi: number;
}

/** Lay out each syllable's phonemes: consonants before the vowel lead into the note, after it close it. */
export function layout(syllables: SungSyllable[]): Seg[] {
  const segs: Seg[] = [];
  for (const sy of syllables) {
    const ph = sy.phonemes.length ? sy.phonemes : ['a'];
    let v = ph.findIndex((p) => VOWELS.has(p));
    if (v < 0) v = 0;
    const onset = ph.slice(0, v);
    const coda = ph.slice(v + 1);
    const len = Math.max(0.05, sy.end - sy.start);
    // The onset may start a little before the note (as singers do), but never before the previous syllable.
    const lead = onset.reduce((s, p) => s + (CONSONANT_S[p] ?? 0.05), 0);
    let t = Math.max(segs.at(-1)?.to ?? 0, sy.start - lead * 0.6);
    const scale = lead > 0 ? Math.min(1, Math.max(0.02, sy.start + lead * 0.4 - t) / lead) : 1;
    for (const p of onset) {
      const d = (CONSONANT_S[p] ?? 0.05) * scale;
      segs.push({ ph: p, from: t, to: t + d, midi: sy.midi });
      t += d;
    }
    const codaLen = Math.min(len * 0.35, coda.reduce((s, p) => s + (CONSONANT_S[p] ?? 0.05), 0));
    const vEnd = Math.max(t + 0.03, sy.end - codaLen);
    segs.push({ ph: ph[v], from: t, to: vEnd, midi: sy.midi });
    t = vEnd;
    for (const p of coda) {
      const d = codaLen / coda.length;
      segs.push({ ph: p, from: t, to: t + d, midi: sy.midi });
      t += d;
    }
  }
  return segs;
}

/** Sing syllables into mono samples, `seconds` long. */
export function singGuide(syllables: SungSyllable[], seconds: number, o: { sampleRate?: number; seed?: number; gain?: number } = {}): Float32Array {
  const sr = o.sampleRate ?? 44100;
  const n = Math.max(1, Math.round(seconds * sr));
  const out = new Float32Array(n);
  const segs = layout(syllables);
  let seed = (o.seed ?? 1) >>> 0 || 1;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  // Filter state per formant, and for the noise band.
  const st = [0, 0, 0, 0, 0, 0].map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  const run = (c: ReturnType<typeof bandpass>, s: { x1: number; x2: number; y1: number; y2: number }, x: number) => {
    const y = c.b0 * x + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
    s.x2 = s.x1;
    s.x1 = x;
    s.y2 = s.y1;
    s.y1 = y;
    return y;
  };
  let phase = 0;
  let k = 0;
  let F = FORMANTS.a.slice() as number[];
  let midiNow = segs[0]?.midi ?? 60;
  let amp = 0;
  const glide = 1 - Math.exp(-1 / (0.035 * sr));
  const ampGlide = 1 - Math.exp(-1 / (0.012 * sr));
  let noteStart = 0;
  let lastMidi = -1;
  let coeffs = FORMANTS.a.map((f, i) => bandpass(f, 60 + 40 * i, sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    while (k < segs.length && segs[k].to <= t) k++;
    const seg = segs[k] && segs[k].from <= t ? segs[k] : null;
    const p = seg?.ph ?? '';
    const voiced = !!seg && !UNVOICED.has(p) && !(PLOSIVE.has(p) && t - seg.from < (seg.to - seg.from) * 0.7);
    const target = seg ? (VOWELS.has(p) ? 1 : SONORANT_GAIN[p] ?? (voiced ? 0.18 : 0)) : 0;
    amp += (target - amp) * ampGlide;
    if (seg) {
      if (seg.midi !== lastMidi) {
        lastMidi = seg.midi;
        noteStart = t;
      }
      // Portamento between notes, then vibrato once the note has settled.
      midiNow += (seg.midi - midiNow) * (1 - Math.exp(-1 / (0.04 * sr)));
      const f = FORMANTS[p];
      if (f) for (let j = 0; j < 3; j++) F[j] += (f[j] - F[j]) * glide;
    }
    if (i % 64 === 0) coeffs = F.map((f, j) => bandpass(f, 70 + 50 * j + f * 0.04, sr));
    const vib = t - noteStart > 0.25 ? 0.25 * Math.sin(2 * Math.PI * 5.6 * t) * Math.min(1, (t - noteStart - 0.25) * 3) : 0;
    const f0 = hz(midiNow + vib);
    phase += f0 / sr;
    if (phase >= 1) phase -= 1;
    // A glottal-like pulse: a falling ramp with a soft closure, rich in harmonics but not buzzy.
    const pulse = (1 - 2 * phase) * (phase < 0.6 ? 1 : (1 - phase) / 0.4) + 0.02 * noise();
    let y = 0;
    if (amp > 1e-4) {
      const src = pulse * amp;
      y = run(coeffs[0], st[0], src) * 1.0 + run(coeffs[1], st[1], src) * 0.5 + run(coeffs[2], st[2], src) * 0.25;
    }
    const nz = NOISE[p];
    if (seg && nz) {
      const into = (t - seg.from) / Math.max(1e-3, seg.to - seg.from);
      // Plosives: silence, then a short burst; fricatives and affricates: noise all through (affricates grow).
      const env = PLOSIVE.has(p) ? (into > 0.7 ? 1 - (into - 0.7) / 0.3 : 0) : p === 'ts' || p === 'tS' || p === 'dz' || p === 'dZ' ? Math.min(1, into * 1.6) : Math.min(1, into * 8, (1 - into) * 8);
      const lo = bandpass(Math.sqrt(nz[0] * nz[1]), nz[1] - nz[0], sr);
      y += run(lo, st[3], noise()) * nz[2] * env * 4;
    }
    out[i] = y;
  }
  // Level: peak at −3 dBFS times gain.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? (0.7 * (o.gain ?? 1)) / peak : 0;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}
