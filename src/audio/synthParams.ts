// Parametric instruments (SPEC v0.6 G5): the parameters of OpenBand's synthesized presets — amplitude and
// filter envelopes, filter cutoff and resonance, FM index and ratio, unison voices and detune, the
// waveform — each with a range, a scale and the preset's own value as default. Track.synthParams
// overrides them (only what changed is stored) and is saved with the song. Pure, apart from the voice
// table it reads.
import { VOICES, type VoiceDef } from './instruments';

export type Scale = 'lin' | 'log' | 'int' | 'enum';
export interface ParamDef {
  id: string;
  group: 'amp' | 'filter' | 'fm' | 'osc' | 'level';
  min: number;
  max: number;
  default: number;
  scale: Scale;
  unit?: 's' | 'Hz' | 'dB' | 'oct' | 'cents' | '';
  /** enum params: the choices, by index. */
  options?: string[];
}

export const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
/** The voice filter when the preset has none of its own: wide open, i.e. no change. */
const OPEN = 18000;

/** A preset's parameters, or null (drum kits, plugins, samplers have none here). */
export function synthSchema(presetId: string): ParamDef[] | null {
  const v: VoiceDef | undefined = VOICES[presetId];
  if (!v) return null;
  const o = v.options;
  const env = o.envelope ?? {};
  const out: ParamDef[] = [
    { id: 'attack', group: 'amp', min: 0.001, max: 4, default: env.attack ?? 0.005, scale: 'log', unit: 's' },
    { id: 'decay', group: 'amp', min: 0.01, max: 6, default: env.decay ?? 0.1, scale: 'log', unit: 's' },
    { id: 'sustain', group: 'amp', min: 0, max: 1, default: env.sustain ?? 0.5, scale: 'lin', unit: '' },
    { id: 'release', group: 'amp', min: 0.01, max: 8, default: env.release ?? 0.3, scale: 'log', unit: 's' },
  ];
  if (v.synth === 'mono') {
    const fe = o.filterEnvelope ?? {};
    out.push(
      { id: 'cutoff', group: 'filter', min: 30, max: OPEN, default: fe.baseFrequency ?? 400, scale: 'log', unit: 'Hz' },
      { id: 'resonance', group: 'filter', min: 0.3, max: 20, default: o.filter?.Q ?? 1, scale: 'log', unit: '' },
      { id: 'filter_env', group: 'filter', min: 0, max: 7, default: fe.octaves ?? 2, scale: 'lin', unit: 'oct' },
      { id: 'filter_attack', group: 'filter', min: 0.001, max: 4, default: fe.attack ?? 0.005, scale: 'log', unit: 's' },
      { id: 'filter_decay', group: 'filter', min: 0.01, max: 6, default: fe.decay ?? 0.3, scale: 'log', unit: 's' },
      { id: 'filter_sustain', group: 'filter', min: 0, max: 1, default: fe.sustain ?? 0.5, scale: 'lin', unit: '' },
    );
  } else {
    // A static filter after the voices (polyphony-safe).
    out.push({ id: 'cutoff', group: 'filter', min: 30, max: OPEN, default: OPEN, scale: 'log', unit: 'Hz' }, { id: 'resonance', group: 'filter', min: 0.3, max: 20, default: 0.7, scale: 'log', unit: '' });
  }
  if (v.synth === 'fm') {
    const me = o.modulationEnvelope ?? {};
    out.push(
      { id: 'fm_index', group: 'fm', min: 0, max: 40, default: o.modulationIndex ?? 3, scale: 'lin', unit: '' },
      { id: 'fm_ratio', group: 'fm', min: 0.25, max: 12, default: o.harmonicity ?? 1, scale: 'log', unit: '' },
      { id: 'fm_decay', group: 'fm', min: 0.01, max: 6, default: me.decay ?? 0.5, scale: 'log', unit: 's' },
      { id: 'fm_sustain', group: 'fm', min: 0, max: 1, default: me.sustain ?? 0.2, scale: 'lin', unit: '' },
    );
  }
  const type = String(o.oscillator?.type ?? 'sine');
  const base = type.replace(/^fat/, '');
  if (WAVES.includes(base) && v.synth !== 'fm') out.push({ id: 'wave', group: 'osc', min: 0, max: WAVES.length - 1, default: WAVES.indexOf(base), scale: 'enum', options: WAVES });
  if (type.startsWith('fat'))
    out.push({ id: 'unison', group: 'osc', min: 1, max: 8, default: o.oscillator.count ?? 3, scale: 'int', unit: '' }, { id: 'detune', group: 'osc', min: 0, max: 80, default: o.oscillator.spread ?? 20, scale: 'lin', unit: 'cents' });
  out.push({ id: 'level', group: 'level', min: -40, max: 0, default: o.volume ?? -12, scale: 'lin', unit: 'dB' });
  return out;
}

export const paramValue = (def: ParamDef, params?: Record<string, number>) => clampParam(def, params?.[def.id] ?? def.default);

export function clampParam(def: ParamDef, v: number): number {
  const x = Math.max(def.min, Math.min(def.max, Number.isFinite(v) ? v : def.default));
  return def.scale === 'int' || def.scale === 'enum' ? Math.round(x) : x;
}

/** A value ↔ 0..1, following its scale (what the search and the knobs use). */
export function toUnit(def: ParamDef, v: number): number {
  if (def.scale === 'log') return Math.log(v / def.min) / Math.log(def.max / def.min);
  return (v - def.min) / (def.max - def.min || 1);
}
export function fromUnit(def: ParamDef, u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return clampParam(def, def.scale === 'log' ? def.min * (def.max / def.min) ** x : def.min + x * (def.max - def.min));
}

/** The Tone options for a preset with some parameters changed (the rest as the preset has them). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function voiceOptions(presetId: string, params: Record<string, number> = {}): { synth: VoiceDef['synth']; options: Record<string, any>; filter: { frequency: number; Q: number } } {
  const v = VOICES[presetId] ?? VOICES['felt-piano'];
  const schema = synthSchema(presetId) ?? [];
  const val = (id: string) => {
    const d = schema.find((x) => x.id === id);
    return d ? paramValue(d, params) : undefined;
  };
  const o = structuredClone(v.options);
  o.envelope = { ...o.envelope, attack: val('attack'), decay: val('decay'), sustain: val('sustain'), release: val('release') };
  o.volume = val('level');
  let filter = { frequency: OPEN, Q: 0.7 };
  if (v.synth === 'mono') {
    o.filter = { ...o.filter, Q: val('resonance') };
    o.filterEnvelope = { ...o.filterEnvelope, baseFrequency: val('cutoff'), octaves: val('filter_env'), attack: val('filter_attack'), decay: val('filter_decay'), sustain: val('filter_sustain') };
  } else filter = { frequency: val('cutoff') ?? OPEN, Q: val('resonance') ?? 0.7 };
  if (v.synth === 'fm') {
    o.modulationIndex = val('fm_index');
    o.harmonicity = val('fm_ratio');
    o.modulationEnvelope = { ...o.modulationEnvelope, decay: val('fm_decay'), sustain: val('fm_sustain') };
  }
  const wave = val('wave');
  if (wave !== undefined) {
    const fat = String(o.oscillator?.type ?? '').startsWith('fat');
    o.oscillator = { ...o.oscillator, type: `${fat ? 'fat' : ''}${WAVES[wave]}` };
    delete o.oscillator.partials;
  }
  if (val('unison') !== undefined) o.oscillator = { ...o.oscillator, count: val('unison'), spread: val('detune') };
  return { synth: v.synth, options: o, filter };
}

/** Only what differs from the preset (what Track.synthParams keeps). */
export function changedParams(presetId: string, params: Record<string, number>): Record<string, number> {
  const schema = synthSchema(presetId) ?? [];
  const out: Record<string, number> = {};
  for (const d of schema) {
    if (params[d.id] === undefined) continue;
    const v = clampParam(d, params[d.id]);
    if (Math.abs(toUnit(d, v) - toUnit(d, d.default)) > 1e-4) out[d.id] = +v.toPrecision(5);
  }
  return out;
}
