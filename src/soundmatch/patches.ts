// Patches (SPEC v0.6 G5): what sound_from_words and match_sound propose — a preset and its parameters —
// kept by id for this page until one is applied (apply_patch) to a track or to a new one.
import { useStore, makeTrack } from '../store';
import { uid } from '../music';
import { presetById } from '../audio/instruments';
import { changedParams, paramValue, synthSchema } from '../audio/synthParams';

export interface Patch {
  id: string;
  preset: string;
  params: Record<string, number>;
  label: string;
  /** 0..1, for patches found from a sample. */
  similarity?: number;
  why?: string[];
}

const patches = new Map<string, Patch>();

export function keepPatch(p: Omit<Patch, 'id'>): Patch {
  const patch = { ...p, id: uid('patch'), params: changedParams(p.preset, p.params) };
  patches.set(patch.id, patch);
  return patch;
}
export const getPatch = (id: string) => patches.get(id);

/** The parameters of a track's synth, with their ranges, and the values it plays now. */
export function describeSynth(trackId: string) {
  const t = useStore.getState().project.tracks.find((x) => x.id === trackId);
  if (!t) throw new Error(`Track "${trackId}" not found`);
  const schema = synthSchema(t.instrument);
  if (!schema) throw new Error(`"${t.name}" doesn't play one of OpenBand's synths (drum kits, samplers and plugins have their own controls)`);
  return { track_id: t.id, preset: t.instrument, params: schema.map((d) => ({ id: d.id, group: d.group, value: +paramValue(d, t.synthParams).toPrecision(4), min: d.min, max: d.max, default: d.default, scale: d.scale, ...(d.unit ? { unit: d.unit } : {}), ...(d.options ? { options: d.options } : {}) })) };
}

/** Set some parameters of a track's synth (one undo step); reset: back to the preset first. */
export function setSynthParams(trackId: string, values: Record<string, number>, reset = false) {
  const t = useStore.getState().project.tracks.find((x) => x.id === trackId);
  if (!t) throw new Error(`Track "${trackId}" not found`);
  const schema = synthSchema(t.instrument);
  if (!schema) throw new Error(`"${t.name}" doesn't play one of OpenBand's synths`);
  const unknown = Object.keys(values).filter((k) => !schema.some((d) => d.id === k));
  if (unknown.length) throw new Error(`Unknown parameters for ${t.instrument}: ${unknown.join(', ')} (it has ${schema.map((d) => d.id).join(', ')})`);
  const next = changedParams(t.instrument, { ...(reset ? {} : t.synthParams), ...values });
  useStore.getState().commit((d) => {
    const x = d.tracks.find((y) => y.id === trackId)!;
    if (Object.keys(next).length) x.synthParams = next;
    else delete x.synthParams;
  });
  return describeSynth(trackId);
}

/** Put a patch on a track (changing its instrument) or on a new one. */
export function applyPatch(patchId: string, trackId?: string) {
  const p = patches.get(patchId);
  if (!p) throw new Error(`No patch "${patchId}" (patches last as long as this page)`);
  const st = useStore.getState();
  let id = trackId;
  if (id) {
    const t = st.project.tracks.find((x) => x.id === id);
    if (!t) throw new Error(`Track "${id}" not found`);
    if (t.kind !== 'instrument') throw new Error('A synth patch goes on an instrument track');
    st.commit((d) => {
      const x = d.tracks.find((y) => y.id === id)!;
      x.instrument = p.preset;
      x.synthParams = { ...p.params };
    });
  } else {
    const t = makeTrack(st.project, 'instrument', p.preset, p.label.slice(0, 40) || presetById(p.preset)?.name);
    t.synthParams = { ...p.params };
    id = t.id;
    st.commit((d) => void d.tracks.push(t));
  }
  return describeSynth(id);
}
