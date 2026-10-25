// From words to a sound (SPEC v0.6 G5): descriptors in Italian and English pick a family and a preset, and
// push its parameters ("caldo" = a lower cutoff, "plucky" = no attack, short decay, no sustain, "largo" =
// unison and detune, "metallico" = FM…). Combinable ("basso caldo e plucky"). A starting point in the
// parameter space, no optimisation; combined with a sample, the same constraints bound the search. Pure.
import { fromUnit, synthSchema, toUnit, type ParamDef } from '../audio/synthParams';

export type Family = 'bass' | 'pluck' | 'pad' | 'lead' | 'keys' | 'bells' | 'organ' | 'strings';

const FAMILY_WORDS: [Family, RegExp][] = [
  ['bass', /\b(bass|basso|bassi|sub|808)\b/],
  ['pluck', /\b(pluck|plucked|pizzicat\w*)\b/],
  ['pad', /\b(pad|tappeto|atmosfer\w*|ambient)\b/],
  ['lead', /\b(lead|solista|synth lead)\b/],
  ['bells', /\b(bell|bells|campan\w*|glocken\w*)\b/],
  ['organ', /\b(organ|organo)\b/],
  ['strings', /\b(string|strings|archi|violin\w*)\b/],
  ['keys', /\b(keys|piano|tastier\w*|rhodes|e\.?piano)\b/],
];

/** The preset each family starts from, and the alternatives that suit some words better. */
const FAMILY_PRESETS: Record<Family, string[]> = {
  bass: ['finger-bass', 'sub-bass', 'acid-bass'],
  pluck: ['pluck'],
  pad: ['aurora-pad'],
  lead: ['neon-lead', 'chip'],
  keys: ['felt-piano', 'velvet-keys'],
  bells: ['crystal-bells'],
  organ: ['retro-organ'],
  strings: ['silk-strings'],
};

/** What a descriptor does: target values (0..1 of each parameter's range) and preferred presets. */
interface Push {
  re: RegExp;
  why: string;
  set?: Record<string, number>;
  /** Multiply the current unit value (e.g. 0.6 = lower). */
  scale?: Record<string, number>;
  prefer?: string[];
}

const PUSHES: Push[] = [
  { re: /\b(cald[oaie]|warm|warmer)\b/, why: 'warm: lower cutoff, little resonance', scale: { cutoff: 0.72 }, set: { resonance: 0.12 } },
  { re: /\b(scur[oaie]|dark|darker|cup[oaie])\b/, why: 'dark: much lower cutoff', scale: { cutoff: 0.58, filter_env: 0.7 } },
  { re: /\b(brillant[ei]|bright|brighter|squillant[ei]|apert[oaie]|open)\b/, why: 'bright: higher cutoff', set: { cutoff: 0.9, filter_env: 0.6 } },
  { re: /\b(plucky|pizzicat[oaie]|percussiv\w*|secc[oa]|secch[ie]|staccat[oaie])\b/, why: 'plucky: instant attack, short decay, no sustain', set: { attack: 0, decay: 0.3, sustain: 0, filter_attack: 0, filter_decay: 0.3, filter_sustain: 0 } },
  { re: /\b(morbid[oaie]|soft|gentle|dolc[ei]|vellutat\w*)\b/, why: 'soft: gentle attack, lower cutoff, no resonance', set: { attack: 0.42, resonance: 0.05 }, scale: { cutoff: 0.85 } },
  { re: /\b(aggressiv\w*|aggressive|graffiante|gritty|cattiv\w*)\b/, why: 'aggressive: resonance, a deep filter sweep, a sawtooth', set: { resonance: 0.6, filter_env: 0.75, wave: 2 / 3 }, prefer: ['acid-bass', 'neon-lead'] },
  { re: /\b(acid\w*)\b/, why: 'acid: high resonance, deep sweep', set: { resonance: 0.8, filter_env: 0.8 }, prefer: ['acid-bass'] },
  { re: /\b(larg[oa]|larghi|larghe|ampi[oae]?|wide|huge|gross[oaie]|fat)\b/, why: 'wide: more unison voices, more detune', set: { unison: 0.7, detune: 0.5 }, prefer: ['aurora-pad', 'silk-strings'] },
  { re: /\b(metallic\w*|metal)\b/, why: 'metallic: FM, a non-integer ratio', set: { fm_index: 0.55, fm_ratio: 0.62 }, prefer: ['crystal-bells', 'velvet-keys'] },
  { re: /\b(lent[oaie]|slow|swell\w*|crescent[ei])\b/, why: 'slow: a slow attack (about half a second)', set: { attack: 0.75 } },
  { re: /\b(lung[oa]|lunghi|lunghe|long|sustained|tenut[oaie])\b/, why: 'long: sustain and a long release', set: { sustain: 0.85, release: 0.62 } },
  { re: /\b(cort[oaie]|short|brev[ei])\b/, why: 'short: short decay and release', set: { decay: 0.28, release: 0.2 } },
  { re: /\b(rotond[oaie]|round|pien[oaie]|deep|profond[oaie])\b/, why: 'round: a pure wave, low cutoff', set: { wave: 1 / 3 }, scale: { cutoff: 0.8 }, prefer: ['sub-bass'] },
  { re: /\b(retro|8.?bit|chip\w*)\b/, why: 'retro: a square wave', set: { wave: 1 }, prefer: ['chip'] },
];

export interface WordsPatch {
  preset: string;
  family: Family;
  params: Record<string, number>;
  why: string[];
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** A family from words (or the one given). */
export function familyOf(text: string, given?: string): Family {
  if (given && given in FAMILY_PRESETS) return given as Family;
  const t = norm(text);
  return FAMILY_WORDS.find(([, re]) => re.test(t))?.[0] ?? 'keys';
}

/** Words → a preset and parameters. */
export function soundFromWords(description: string, family?: string): WordsPatch {
  const t = norm(description);
  const fam = familyOf(t, family);
  const pushes = PUSHES.filter((p) => p.re.test(t));
  const candidates = FAMILY_PRESETS[fam];
  const preferred = pushes.flatMap((p) => p.prefer ?? []).find((id) => candidates.includes(id));
  const preset = preferred ?? candidates[0];
  const schema = synthSchema(preset) ?? [];
  const unit: Record<string, number> = Object.fromEntries(schema.map((d) => [d.id, toUnit(d, d.default)]));
  const why: string[] = [`${fam}: ${preset}${preferred ? ' (it suits the words)' : ''}`];
  for (const p of pushes) {
    let used = false;
    for (const [id, u] of Object.entries(p.scale ?? {}))
      if (id in unit) {
        unit[id] *= u;
        used = true;
      }
    for (const [id, u] of Object.entries(p.set ?? {}))
      if (id in unit) {
        unit[id] = u;
        used = true;
      }
    if (used) why.push(p.why);
  }
  const params: Record<string, number> = {};
  for (const d of schema as ParamDef[]) {
    const v = fromUnit(d, unit[d.id]);
    if (Math.abs(unit[d.id] - toUnit(d, d.default)) > 1e-4) params[d.id] = +v.toPrecision(4);
  }
  return { preset, family: fam, params, why };
}
