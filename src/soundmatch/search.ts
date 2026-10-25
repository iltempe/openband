// Sound-alike search (SPEC v0.6 G5): from a note (a sample, or a stretch of the reference) to the patch of
// one of OpenBand's synths that sounds most like it. Multi-start from every compatible preset's defaults
// (and its waves), then CMA-ES on the most promising ones over the normalised parameters; each candidate
// is a note rendered offline at the same pitch and length, a whole generation per render. Everything runs
// in the page: nothing is uploaded.
import * as Tone from 'tone';
import { createInstrument, PRESETS } from '../audio/instruments';
import { fromUnit, synthSchema, toUnit, type ParamDef } from '../audio/synthParams';
import { yinTrack } from '../analysis/pitchtrack';
import { minimise } from './cmaes';
import { distance, noteFeatures, onsetSample, similarity, type NoteFeatures } from './features';
import { soundFromWords, type Family } from './words';

// The rate notes are rendered and compared at: the song's own (some presets misbehave at 22 kHz).
export const SR = 44100;
const FAMILY_OF: Record<string, Family> = {
  'felt-piano': 'keys', 'velvet-keys': 'keys', 'retro-organ': 'organ', 'crystal-bells': 'bells', 'neon-lead': 'lead', pluck: 'pluck', chip: 'lead',
  'sub-bass': 'bass', 'acid-bass': 'bass', 'finger-bass': 'bass', 'aurora-pad': 'pad', 'silk-strings': 'strings',
};
export const familyOfPreset = (id: string) => FAMILY_OF[id];

export interface Target {
  features: NoteFeatures;
  midi: number;
  /** How long it sounds (s) and how long the note is held (estimated). */
  seconds: number;
  held: number;
  /** A word about the input (polyphonic, noisy…). */
  warning?: string;
}

/** Read a note: its pitch (YIN, median of the voiced frames), how long it sounds, its features. */
export function analyseTarget(x: Float32Array, sampleRate: number): Target {
  // To the search's rate: linear resampling is enough for the features.
  const y = sampleRate === SR ? x : Float32Array.from({ length: Math.floor((x.length * SR) / sampleRate) }, (_, i) => {
    const t = (i * sampleRate) / SR;
    const k = Math.floor(t);
    return (x[k] ?? 0) * (1 - (t - k)) + (x[k + 1] ?? 0) * (t - k);
  });
  const from = onsetSample(y, SR);
  const z = y.subarray(from);
  // How long it sounds: until 40 dB below the peak (at most 4 s).
  let peak = 0;
  for (const v of z) peak = Math.max(peak, Math.abs(v));
  let end = z.length;
  const hop = Math.round(SR * 0.01);
  for (let i = z.length - hop; i > 0; i -= hop) {
    let m = 0;
    for (let j = i; j < i + hop; j++) m = Math.max(m, Math.abs(z[j]));
    if (m > peak * 0.01) {
      end = i + hop;
      break;
    }
  }
  const seconds = Math.min(4, Math.max(0.15, end / SR));
  const frames = yinTrack(z.subarray(0, Math.min(z.length, Math.round(seconds * SR))), SR, { minHz: 30, maxHz: 2000 }).filter((f) => f.midi !== null && f.aperiodicity < 0.3);
  const midis = frames.map((f) => f.midi!).sort((a, b) => a - b);
  const midi = midis.length ? Math.round(midis[Math.floor(midis.length / 2)]) : 60;
  const voiced = frames.length / Math.max(1, Math.round(seconds * 100) / 2.56);
  const features = noteFeatures(z, SR, seconds);
  // Held: while the envelope stays on its sustain (60 % of the plateau, or 5 % of the peak), then the release.
  const rms = features.rms;
  const pk = Math.max(...rms);
  const floor = Math.max(pk * 0.05, features.sustain * pk * 0.6);
  let last = 0;
  rms.forEach((v, i) => v > floor && (last = i));
  const held = Math.min(seconds, Math.max(0.1, (last + 1) * 0.01));
  const warning = !midis.length ? 'no clear pitch: a drum or a noise is matched by its envelope and colour only' : voiced < 0.3 ? 'the pitch is unstable (a chord or a busy mix?): the match may be rough — isolate one note if you can' : undefined;
  return { features, midi, seconds, held, ...(warning ? { warning } : {}) };
}

/**
 * Render one note per parameter set. Each in its own short offline context, all at once: Chrome renders
 * offline contexts on their own threads, and one long context with every candidate in it costs far more
 * (each instrument runs for the whole render).
 */
let inFlight = 0;
export async function renderCandidates(preset: string, list: Record<string, number>[], t: Pick<Target, 'midi' | 'seconds' | 'held'>): Promise<Float32Array[]> {
  const len = t.seconds + 0.01;
  // Not Tone.Offline: it restores the global context only after rendering, so renders in flight together
  // leave it pointing at a finished offline context. The context is switched only while building.
  const one = async (params: Record<string, number>) => {
    const ctx = new Tone.OfflineContext(1, len, SR);
    const prev = Tone.getContext();
    Tone.setContext(ctx);
    try {
      const inst = createInstrument(preset, undefined, undefined, params);
      inst.setCutoff(1);
      inst.output.toDestination();
      inst.trigger(t.midi, t.held, 0.005, 0.85);
    } finally {
      Tone.setContext(prev);
    }
    inFlight++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const buf = await Promise.race([
      ctx.render(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`A render of ${preset} did not finish (${inFlight} in flight)`)), 20000))),
    ]).finally(() => {
      clearTimeout(timer);
      inFlight--;
    });
    const out = buf.getChannelData(0).slice();
    void ctx.dispose();
    return out;
  };
  return Promise.all(list.map(one));
}

export interface Match {
  preset: string;
  params: Record<string, number>;
  similarity: number;
}

/** What the search moves: what shapes a note most (the rest stays where the start put it). */
const SEARCHED = new Set(['attack', 'decay', 'sustain', 'release', 'cutoff', 'resonance', 'filter_env', 'fm_index']);
const continuous = (s: ParamDef[]) => s.filter((d) => SEARCHED.has(d.id));

/** The best patches for a target: top 3, each a different preset when that's close. */
export async function matchSound(target: Target, o: { family?: string; budget?: number; words?: string; onProgress?: (done: number, total: number, best: number) => void } = {}): Promise<Match[]> {
  const budget = Math.max(30, o.budget ?? 300);
  const fam = o.family ?? (o.words ? soundFromWords(o.words).family : undefined);
  const presets = PRESETS.filter((p) => p.kind === 'instrument' && synthSchema(p.id) && (!fam || FAMILY_OF[p.id] === fam)).map((p) => p.id);
  let evals = 0;
  const cost = async (preset: string, list: Record<string, number>[]) => {
    const audio = await renderCandidates(preset, list, target);
    evals += list.length;
    return audio.map((x) => distance(target.features, noteFeatures(x, SR, target.seconds)));
  };
  // 1. Starts: each preset probed at a few points — its defaults (or the words' patch), the target's own
  // envelope, and that envelope at five cutoffs from dark to bright — and each wave it can take.
  const f = target.features;
  const envelope: Record<string, number> = { attack: Math.max(0.001, f.attack * 1.25), decay: Math.max(0.01, f.decay), sustain: Math.min(1, f.sustain), release: Math.max(0.01, target.seconds - target.held) };
  const starts: { preset: string; params: Record<string, number>; f: number }[] = [];
  for (const preset of presets) {
    const schema = synthSchema(preset)!;
    const base = o.words ? (soundFromWords(o.words, FAMILY_OF[preset]).preset === preset ? soundFromWords(o.words, FAMILY_OF[preset]).params : {}) : {};
    const cut = schema.find((d) => d.id === 'cutoff')!;
    const env = Object.fromEntries(Object.entries(envelope).filter(([id]) => schema.some((d) => d.id === id)));
    const probes: Record<string, number>[] = [base, { ...base, ...env }, ...[0.25, 0.4, 0.55, 0.7, 0.85].map((u) => ({ ...base, ...env, cutoff: fromUnit(cut, u) }))];
    const wave = schema.find((d) => d.id === 'wave');
    if (wave) for (let i = 0; i < wave.options!.length; i++) if (i !== wave.default) probes.push({ ...base, ...env, wave: i });
    const fs = await cost(preset, probes);
    probes.forEach((params, i) => starts.push({ preset, params, f: fs[i] }));
    o.onProgress?.(evals, budget, Math.min(...starts.map((s) => s.f)));
  }
  starts.sort((a, b) => a.f - b.f);
  // 2. CMA-ES on the best starts of different presets (more budget to the best). The search starts where
  // the target's own envelope says (attack, decay, sustain, release), and searches how long the note was
  // held too (it can't be read exactly, and it changes the sound a lot).
  const picks = starts.filter((s, i) => starts.findIndex((x) => x.preset === s.preset) === i).slice(0, 3);
  const left = Math.max(0, budget - evals);
  const results: Match[] = [];
  // Each pick: its state in the search (units of its parameters, the held time) and how close it got.
  const runs = picks.map((s) => {
    const schema = synthSchema(s.preset)!;
    return { s, schema, unit: Object.fromEntries(schema.map((d) => [d.id, toUnit(d, s.params[d.id] ?? d.default)])) as Record<string, number>, heldU: Math.max(0, Math.min(1, (target.held / target.seconds - 0.3) / 0.7)), best: s.f };
  });
  const heldOf = (u: number) => target.seconds * (0.3 + 0.7 * u);
  const paramsOf = (r: (typeof runs)[number], u: Record<string, number>) => Object.fromEntries(r.schema.map((d) => [d.id, d.scale === 'enum' ? (r.s.params[d.id] ?? d.default) : fromUnit(d, u[d.id])]));
  const evalPoints = async (r: (typeof runs)[number], points: { u: Record<string, number>; held: number }[]) => {
    const out: number[] = [];
    await Promise.all(points.map(async (pt, i) => {
      const [y] = await renderCandidates(r.s.preset, [paramsOf(r, pt.u)], { ...target, held: heldOf(pt.held) });
      evals++;
      out[i] = distance(target.features, noteFeatures(y, SR, target.seconds));
    }));
    return out;
  };
  /** One sweep over the main parameters and the held time: n values per dimension, ±half around the current one. */
  const sweep = async (r: (typeof runs)[number], n: number, half: number, cap: number) => {
    const main = ['cutoff', 'attack', 'decay', 'sustain', 'release'].filter((id) => r.schema.some((d) => d.id === id));
    // The held time first: with it wrong, the envelope's parameters bend to make up for it.
    for (const dim of ['held', ...main]) {
      if (evals + n > cap) return;
      const at = dim === 'held' ? r.heldU : r.unit[dim];
      const lo = half >= 0.5 ? 0 : Math.max(0, at - half);
      const hi = half >= 0.5 ? 1 : Math.min(1, at + half);
      const values = Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
      const fs = await evalPoints(r, values.map((v) => (dim === 'held' ? { u: r.unit, held: v } : { u: { ...r.unit, [dim]: v }, held: r.heldU })));
      const i = fs.indexOf(Math.min(...fs));
      if (fs[i] < r.best) {
        r.best = fs[i];
        if (dim === 'held') r.heldU = values[i];
        else r.unit[dim] = values[i];
      }
      o.onProgress?.(evals, budget, Math.min(...runs.map((x) => x.best)));
    }
  };
  // Phase 1: the same coarse sweep for every pick, so they compete fairly.
  const coarse = Math.max(5, Math.min(9, Math.floor(left / (runs.length * 6 * 2))));
  for (const r of runs) await sweep(r, coarse, 0.5, budget);
  // Phase 2: the winner gets the rest — finer sweeps, then CMA-ES with the filter's and FM's shape too
  // (kept only if it is better).
  runs.sort((a, b) => a.best - b.best);
  const w = runs[0];
  for (const [n, half] of [[coarse, 0.5], [7, 0.12], [5, 0.04]] as [number, number][]) await sweep(w, n, half, budget);
  const dims = continuous(w.schema);
  if (budget - evals >= 20 && dims.length) {
    const start = [...dims.map((d) => w.unit[d.id]), w.heldU];
    const r = await minimise(async (xs) => evalPoints(w, xs.map((x) => ({ u: { ...w.unit, ...Object.fromEntries(dims.map((d, i) => [d.id, x[i]])) }, held: x[x.length - 1] }))), start, budget - evals, { sigma: 0.12, seed: 7, onGeneration: (fb) => o.onProgress?.(evals, budget, Math.min(fb, w.best)) });
    if (r.f < w.best * 0.97) {
      w.best = r.f;
      dims.forEach((d, i) => (w.unit[d.id] = r.x[i]));
      w.heldU = r.x[r.x.length - 1];
    }
  }
  for (const r of runs) {
    results.push({ preset: r.s.preset, params: paramsOf(r, r.unit), similarity: +similarity(r.best).toFixed(3) });
  }
  return results.sort((a, b) => b.similarity - a.similarity);
}
