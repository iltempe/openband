// voice.sing as a builtin OMEP engine: OpenBand's guide voice sings the Song Context Package's melody on
// its lyrics (the phonemes the context carries, Italian from g2p.it), instantly, in the page.
import type { BuiltinEngine } from '../ensemble/builtin';
import type { Contribution, OmepLicense, Scp, ScpNote } from '../ensemble/types';
import { encodeWavChannels } from '../audio/samples';
import { phonemesOfSyllable } from '../lyrics/g2p.it';
import { singGuide, type SungSyllable } from './voice';

const SR = 44100;
/** The scope in beats and bars (builtin.ts imports this file, so nothing is imported from it). */
const scopeOf = (scp: Scp) => {
  const fromBar = scp.scope?.from_bar ?? 1;
  const toBar = scp.scope?.to_bar ?? fromBar + scp.song.length_bars;
  return { fromBar, bars: toBar - fromBar, from: (fromBar - 1) * 4, to: (toBar - 1) * 4 };
};
const LICENSE: OmepLicense = { code: 'MIT', weights: null, commercial: 'yes', attribution: null, conditions: null, url: 'https://github.com/iltempe/openband/blob/main/LICENSE' };
const VOWELS = new Set(['a', 'e', 'E', 'i', 'o', 'O', 'u']);

/** What to sing: each melody note of the scope with its syllable (or the vowel it holds). Seconds from the scope. */
export function sungSyllables(scp: Scp): SungSyllable[] {
  const spb = 60 / scp.song.bpm;
  const s = scopeOf(scp);
  const span = s.to - s.from;
  const notes: ScpNote[] = (scp.melody?.notes ?? []).filter((n) => n.start >= -1e-6 && n.start < span).sort((a, b) => a.start - b.start);
  const lines = scp.lyrics?.lines ?? [];
  const syl = lines.flatMap((l) => l.syllables ?? []);
  const timed = syl.filter((x) => typeof x.start_beat === 'number' && x.start_beat >= -1e-6 && x.start_beat < span);
  const untimed = timed.length ? [] : syl.slice();
  const out: SungSyllable[] = [];
  let held: string[] = ['a'];
  for (const n of notes) {
    let sy = timed.find((x) => Math.abs((x.start_beat as number) - n.start) < 0.13);
    if (!sy && untimed.length) sy = untimed.shift();
    let ph: string[];
    if (sy) {
      ph = sy.phonemes?.length ? sy.phonemes : phonemesOfSyllable(sy.text);
      const v = ph.find((p) => VOWELS.has(p));
      if (v) held = [v];
    } else ph = held; // a melisma, or a melody without words: the vowel goes on
    out.push({ text: sy?.text ?? '', start: n.start * spb, end: (n.start + n.duration) * spb, midi: n.pitch, phonemes: ph });
  }
  return out;
}

export const voiceEngine: BuiltinEngine = {
  manifest: {
    omep: '1.0',
    engine: { id: 'openband-voice', name: 'OpenBand Guide voice', version: '1.0.0', homepage: 'https://github.com/iltempe/openband' },
    license: LICENSE,
    runtime: { where: 'builtin', device: ['cpu'], realtime: true },
    capabilities: { 'voice.sing': { conditioning: ['melody', 'lyrics', 'phonemes', 'bpm'] } },
    outputs: ['audio/wav'],
    languages: ['it', 'en'],
    determinism: 'deterministic',
  },
  async run(_cap, input): Promise<Contribution> {
    const scp = input.context;
    const s = scopeOf(scp);
    const sung = sungSyllables(scp);
    if (!sung.length) throw new Error('Nothing to sing: the melody track has no notes in those bars');
    const seconds = ((s.to - s.from) * 60) / scp.song.bpm;
    const pcm = singGuide(sung, seconds, { sampleRate: SR, seed: input.seed ?? 1 });
    const uri = URL.createObjectURL(new Blob([encodeWavChannels([pcm], SR)], { type: 'audio/wav' }));
    const words = sung.filter((x) => x.text);
    return {
      kind: 'audio',
      files: [{ uri, role: 'vocal', format: 'wav', sample_rate: SR, channels: 1 }],
      alignment: { start_bar: s.fromBar, syllables: words.map((x) => ({ text: x.text, start_ms: Math.round(x.start * 1000), end_ms: Math.round(x.end * 1000) })) },
      claims: { bpm: scp.song.bpm, key: scp.song.key, length_bars: s.bars },
      provenance: { engine: 'openband-voice', engine_version: '1.0.0', model_hash: 'none', seed: input.seed ?? 1, capability: 'voice.sing', prompt: words.length ? words.map((x) => x.text).join(' ').slice(0, 200) : 'on "a"' },
      license: LICENSE,
    };
  },
};
