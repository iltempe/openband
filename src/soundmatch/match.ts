// match_sound (SPEC v0.6 G5): a sound in, the three closest patches out — each kept as a candidate to
// audition (original vs patch, loudness-matched) and apply. All in the page.
import * as Tone from 'tone';
import { create } from 'zustand';
import { analyseTarget, matchSound, renderCandidates, type Target } from './search';
import { keepPatch, getPatch } from './patches';
import { resolveSource, type SoundSource } from './tone';
import { presetById } from '../audio/instruments';

export const useMatch = create<{ busy: boolean; done: number; total: number; best: number | null }>(() => ({ busy: false, done: 0, total: 0, best: null }));

const targets = new Map<string, { target: Target; x: Float32Array; sampleRate: number }>();

export async function matchSoundCommand(a: SoundSource & { family?: string; budget?: number; words?: string; target?: 'synth' | 'plugin' | 'auto' }) {
  if (a.target === 'plugin') throw new Error('Matching with WAM plugins is not available yet: use target "synth" (OpenBand’s synths)');
  const src = resolveSource(a);
  const t = analyseTarget(src.x, src.sampleRate);
  useMatch.setState({ busy: true, done: 0, total: a.budget ?? 300, best: null });
  const t0 = performance.now();
  try {
    const found = await matchSound(t, { family: a.family, budget: a.budget, words: a.words, onProgress: (done, total, best) => useMatch.setState({ done, total, best }) });
    const out = found.map((m) => {
      const patch = keepPatch({ preset: m.preset, params: m.params, label: `${presetById(m.preset)?.name ?? m.preset} like ${src.name}`, similarity: m.similarity });
      targets.set(patch.id, { target: t, x: src.x, sampleRate: src.sampleRate });
      return { candidate_id: patch.id, preset: m.preset, similarity: m.similarity, params: patch.params };
    });
    return { candidates: out, pitch: t.midi, seconds: +t.seconds.toFixed(2), took_s: +((performance.now() - t0) / 1000).toFixed(1), ...(t.warning ? { warning: t.warning } : {}), note: 'Audition with the A/B in Sound, then apply_patch the one you like.' };
  } finally {
    useMatch.setState({ busy: false });
  }
}

/** Hear the original, then the patch, at the same loudness. */
export async function auditionCandidate(candidateId: string) {
  const p = getPatch(candidateId);
  const t = targets.get(candidateId);
  if (!p || !t) throw new Error('This candidate can’t be auditioned any more');
  const [note] = await renderCandidates(p.preset, [p.params], t.target);
  const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));
  const orig = t.x.subarray(0, Math.round(t.target.seconds * t.sampleRate) + Math.round(0.05 * t.sampleRate));
  const g = rms(orig) / Math.max(1e-6, rms(note));
  // Each at its own rate (the patch is rendered at 22.05 kHz): played at the context's it would change pitch.
  const buf = (x: Float32Array, sr: number) => {
    const ab = Tone.getContext().createBuffer(1, x.length, sr);
    ab.copyToChannel(x, 0);
    return new Tone.ToneAudioBuffer(ab as AudioBuffer);
  };
  await Tone.start();
  const a = new Tone.Player(buf(orig, t.sampleRate)).toDestination();
  const b = new Tone.Player(buf(Float32Array.from(note, (v) => v * g), 22050)).toDestination();
  const now = Tone.now() + 0.05;
  a.start(now);
  b.start(now + t.target.seconds + 0.4);
  setTimeout(() => (a.dispose(), b.dispose()), (t.target.seconds * 2 + 1.5) * 1000);
}
