// Web Audio Module plugins in the project: adding/removing them, finding them from a plain-language
// description, reading and writing their parameters, and saving their state into the project.
import type { CustomInstrument, PluginSlot } from './types';
import { allLiveNatives, liveNative, nativeHooks, type NativeEffect, type NativePluginInfo } from './audio/native';
import { setProjectPluginState } from './pluginHistory';
import { getTrack, makeTrack, useStore } from './store';
import { uid } from './music';
import { normalizeFx } from './audio/fx';
import { PluginStateSync, projectPluginStates, trimPluginHistory, type LivePlugin } from './pluginHistory';
import { liveWams, resolvePlugin, wamCatalog, wamErrors, type WamCatalogEntry, type WamInstance } from './audio/wam';

const st = () => useStore.getState();

// ---------- search by description ----------

/** Italian (and a few English variants) → the vocabulary used in the plugin catalog. */
const SYNONYMS: Record<string, string[]> = {
  riverbero: ['reverb'], riverberazione: ['reverb'], ambiente: ['reverb', 'ambient'], stanza: ['reverb'], hall: ['reverb'], spazio: ['reverb', 'ambient'], spaziale: ['reverb', 'shimmer'],
  eco: ['delay', 'echo'], ritardo: ['delay'], echo: ['delay'],
  distorsione: ['distortion', 'overdrive', 'fuzz'], distorto: ['distortion', 'fuzz'], saturazione: ['distortion', 'overdrive', 'tube'], sporco: ['distortion', 'dirty', 'fuzz'], crunch: ['overdrive', 'distortion'], drive: ['overdrive'],
  valvolare: ['tube', 'amp'], valvole: ['tube'], amplificatore: ['amp', 'amplifier', 'guitarsimamplifier'], ampli: ['amp'], chitarra: ['guitar', 'amp', 'pedal'], pedale: ['pedal'],
  equalizzatore: ['eq', 'equalizer'], eq: ['equalizer'], filtro: ['filter', 'eq', 'wah'], wah: ['wah'],
  modulazione: ['modulation', 'phaser', 'flanger', 'chorus'], phaser: ['phaser'], flanger: ['flanger'], chorus: ['chorus'], vibrato: ['vibrato'],
  intonazione: ['pitch', 'pitchshifter'], ottava: ['pitch', 'octave'], pitch: ['pitchshifter'],
  stereo: ['stereo', 'width'], largo: ['stereo', 'width'], ampio: ['stereo', 'width', 'reverb'],
  gate: ['gate', 'noise'], rumore: ['noise', 'gate'],
  compressore: ['compressor', 'dynamics'], volume: ['gain'],
  sintetizzatore: ['synth', 'synthesizer'], synth: ['synthesizer'], monofonico: ['monophonic', 'synth'], analogico: ['analog', 'synth'],
  batteria: ['drum', 'drum-machine', 'sampler'], drum: ['drum-machine'], drums: ['drum-machine'], percussioni: ['drum', 'drum-machine'],
  campionatore: ['sampler'], soundfont: ['soundfont', 'sampler'], pianoforte: ['soundfont', 'sampler'], piano: ['soundfont'],
  modale: ['modal'], campane: ['modal', 'bell'], metallico: ['modal', 'bell'],
  visualizzatore: ['visualization', 'oscilloscope', 'spectrum'], spettro: ['spectrogram', 'spectroscope'],
  scuro: ['dark', 'warm'], caldo: ['warm', 'tube', 'vintage'], brillante: ['bright', 'shimmer'], morbido: ['soft', 'smooth'], aggressivo: ['aggressive', 'distortion', 'fuzz'], vintage: ['vintage', 'classic'], retro: ['vintage', 'classic'], luccicante: ['shimmer'], etereo: ['shimmer', 'ambient'],
};
/** Descriptive words: they refine a search but must not outweigh the kind of effect asked for. */
const WEAK = new Set(['scuro', 'caldo', 'brillante', 'morbido', 'aggressivo', 'vintage', 'retro', 'luccicante', 'etereo', 'ampio', 'largo', 'spazio', 'spaziale', 'ambiente', 'stanza', 'sporco', 'valvolare', 'valvole', 'analogico', 'monofonico', 'metallico', 'stereo', 'volume', 'pianoforte', 'piano']);
const INSTRUMENT_WORDS = /\b(instrument|strumento|synth|sintetizzatore|sampler|campionatore|drum|batteria|player|suonare|play)/;
const EFFECT_WORDS = /\b(effect|effetto|reverb|riverbero|delay|eco|distors|overdrive|fuzz|amp|eq|equaliz|phaser|flanger|chorus|wah|pedal|pedale|filtro)/;
const STOP = new Set(['a', 'an', 'the', 'and', 'for', 'with', 'of', 'to', 'un', 'una', 'uno', 'il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'da', 'per', 'con', 'e', 'che', 'del', 'della', 'sul', 'sulla', 'al', 'alla', 'mi', 'serve', 'voglio', 'metti', 'aggiungi', 'add', 'some', 'plugin']);

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export interface PluginMatch extends WamCatalogEntry {
  score: number;
}

export async function searchPlugins(query: string, kind?: 'instrument' | 'effect', limit = 5): Promise<PluginMatch[]> {
  const list = await wamCatalog();
  const q = norm(query);
  const wantKind = kind ?? (INSTRUMENT_WORDS.test(q) && !EFFECT_WORDS.test(q) ? 'instrument' : EFFECT_WORDS.test(q) && !INSTRUMENT_WORDS.test(q) ? 'effect' : undefined);
  const words = q.split(/[^a-z0-9#+-]+/).filter((w) => w.length > 1 && !STOP.has(w));
  const terms = new Map<string, number>();
  for (const w of words) {
    terms.set(w, Math.max(terms.get(w) ?? 0, 1));
    const synWeight = WEAK.has(w) ? 0.35 : 0.9;
    for (const syn of SYNONYMS[w] ?? []) terms.set(syn, Math.max(terms.get(syn) ?? 0, synWeight));
  }
  const scored = list
    .filter((p) => !wantKind || p.kind === wantKind)
    .map((p) => {
      const name = norm(p.name);
      const keys = p.keywords.map(norm).join(' ');
      const cats = p.categories.map(norm).join(' ');
      const desc = norm(p.description);
      let score = 0;
      for (const [term, weight] of terms) {
        const stem = term.length > 4 ? term.slice(0, -1) : term;
        // "reverb" should also find names like KBVerb or Microverb.
        const nameStem = stem === 'rever' ? 'verb' : stem;
        if (name.includes(nameStem)) score += 5 * weight;
        if (keys.includes(stem)) score += 3 * weight;
        if (cats.includes(stem)) score += 3 * weight;
        if (desc.includes(stem)) score += 1 * weight;
      }
      return { ...p, score: +score.toFixed(2) };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------- adding and removing ----------

export async function addPluginInstrument(ref: string, trackId?: string) {
  const plugin = await resolvePlugin(ref);
  if (plugin.kind === 'effect') throw new Error(`“${plugin.name}” is an effect: use add_plugin_effect`);
  const inst: CustomInstrument = { id: uid('wam'), name: plugin.name, kind: 'instrument', source: 'wam', zones: [], attack: 0, release: 0, wam: { url: plugin.url } };
  st().commit((d) => void (d.instruments = [...(d.instruments ?? []), inst]));
  let id = trackId;
  const s = st();
  if (id && getTrack(s.project, id)?.kind !== 'instrument') throw new Error('Plugin instruments go on instrument tracks');
  if (id) {
    s.commit((d) => void (d.tracks.find((t) => t.id === id)!.instrument = inst.id));
  } else {
    const track = makeTrack(s.project, 'instrument', inst.id, plugin.name);
    s.commit((d) => void d.tracks.push(track));
    s.set({ selectedTrackId: track.id });
    id = track.id;
  }
  return { instrument_id: inst.id, track_id: id, name: plugin.name, url: plugin.url };
}

export async function addPluginEffect(trackId: string, ref: string) {
  const track = getTrack(st().project, trackId);
  if (!track) throw new Error(`Track "${trackId}" not found`);
  const plugin = await resolvePlugin(ref);
  if (plugin.kind === 'instrument') throw new Error(`“${plugin.name}” is an instrument: use add_plugin_instrument`);
  const slot: PluginSlot = { id: uid('fx'), url: plugin.url, name: plugin.name, on: true };
  st().commit((d) => {
    const t = d.tracks.find((x) => x.id === trackId)!;
    t.fx = normalizeFx(t.fx);
    t.fx.plugins = [...(t.fx.plugins ?? []), slot];
  });
  return { track_id: trackId, slot_id: slot.id, name: plugin.name, url: plugin.url };
}

/** A native plugin instrument (G8, desktop app) found by the scan: on a new track, or on trackId. */
export function addNativeInstrument(p: NativePluginInfo, trackId?: string) {
  if (p.kind !== 'instrument') throw new Error(`“${p.name}” is an effect`);
  const inst: CustomInstrument = { id: uid('nat'), name: p.name, kind: 'instrument', source: 'native', zones: [], attack: 0, release: 0, format: p.format, native: { id: p.id, vendor: p.vendor, version: p.version, path_hint: p.path } };
  const s = st();
  if (trackId && getTrack(s.project, trackId)?.kind !== 'instrument') throw new Error('Plugin instruments go on instrument tracks');
  s.commit((d) => {
    d.instruments = [...(d.instruments ?? []), inst];
    if (trackId) d.tracks.find((t) => t.id === trackId)!.instrument = inst.id;
  });
  let id = trackId;
  if (!id) {
    const track = makeTrack(st().project, 'instrument', inst.id, p.name);
    st().commit((d) => void d.tracks.push(track));
    st().set({ selectedTrackId: track.id });
    id = track.id;
  }
  return { instrument_id: inst.id, track_id: id, name: p.name, format: p.format };
}

/** A native plugin effect (G8, desktop app) found by the scan, at the end of a track's chain. */
export function addNativeEffect(trackId: string, p: NativePluginInfo) {
  const track = getTrack(st().project, trackId);
  if (!track) throw new Error(`Track "${trackId}" not found`);
  if (p.kind === 'instrument') throw new Error(`“${p.name}” is an instrument`);
  const slot: PluginSlot = { id: uid('fx'), url: '', name: p.name, on: true, format: p.format, native: { id: p.id, vendor: p.vendor, version: p.version, path_hint: p.path } };
  st().commit((d) => {
    const t = d.tracks.find((x) => x.id === trackId)!;
    t.fx = normalizeFx(t.fx);
    t.fx.plugins = [...(t.fx.plugins ?? []), slot];
  });
  return { track_id: trackId, slot_id: slot.id, name: p.name, format: p.format };
}

export function removePluginEffect(trackId: string, slotId: string) {
  st().commit((d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    if (t?.fx?.plugins) t.fx.plugins = t.fx.plugins.filter((p) => p.id !== slotId);
  });
}

export function updateSlot(trackId: string, slotId: string, fn: (s: PluginSlot) => void, history = true) {
  st().commit((d) => {
    const slot = d.tracks.find((x) => x.id === trackId)?.fx?.plugins?.find((p) => p.id === slotId);
    if (slot) fn(slot);
  }, { history });
}

// ---------- live instances: parameters and state ----------

/** The live plugin of a track: its instrument (slotId omitted) or one of its effects. Waits for it to load. */
export async function livePlugin(trackId: string, slotId?: string, timeoutMs = 20000): Promise<WamInstance> {
  const key = `${trackId}:${slotId ?? 'instrument'}`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const inst = liveWams.get(key);
    if (inst) return inst;
    const err = wamErrors.get(key);
    if (err) throw new Error(`The plugin failed to load: ${err}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(slotId ? `Plugin ${slotId} on track ${trackId} is not loaded (failed or still loading)` : `Track ${trackId} has no loaded plugin instrument`);
}

/** A live native plugin (G8) of a track, once loaded; null when that slot isn't a native plugin. */
async function liveNativeOf(trackId: string, slotId?: string, timeoutMs = 20000): Promise<NativeEffect | null> {
  const p = st().project;
  const t = getTrack(p, trackId);
  const native = slotId ? (t?.fx?.plugins?.find((s) => s.id === slotId)?.format ?? 'wam') !== 'wam' : p.instruments?.find((i) => i.id === t?.instrument)?.source === 'native';
  if (!native) return null;
  const key = `${trackId}:${slotId ?? 'instrument'}`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = liveNative(key);
    if (n?.error) throw new Error(`The plugin failed to load: ${n.error}`);
    if (n?.params.length || (n && n.activeLatency)) return n;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The native plugin of track ${trackId} is not running (it needs the desktop app)`);
}

export async function getPluginParams(trackId: string, slotId?: string) {
  const n = await liveNativeOf(trackId, slotId);
  if (n)
    return n.params.map((p) => ({
      id: String(p.id),
      label: p.name,
      value: +(n.values.get(p.id) ?? p.value).toFixed(4),
      min: p.min,
      max: p.max,
      ...(p.stepped ? { stepped: true } : {}),
    }));
  const node = (await livePlugin(trackId, slotId)).audioNode;
  const [info, values] = await Promise.all([node.getParameterInfo(), node.getParameterValues(false)]);
  return Object.values(info).map((p) => ({
    id: p.id,
    label: p.label || p.id,
    value: +(values[p.id]?.value ?? p.defaultValue).toFixed(4),
    min: p.minValue,
    max: p.maxValue,
    ...(p.units ? { units: p.units } : {}),
    ...(p.choices?.length ? { choices: p.choices } : {}),
  }));
}

export async function setPluginParams(trackId: string, slotId: string | undefined, values: Record<string, number>) {
  const n = await liveNativeOf(trackId, slotId);
  if (n) {
    const set: string[] = [];
    for (const [id, v] of Object.entries(values)) {
      const p = n.params.find((x) => String(x.id) === id) ?? n.params.find((x) => x.name.toLowerCase() === id.toLowerCase());
      if (!p) throw new Error(`Unknown parameter "${id}". Call get_plugin_params.`);
      n.setParam(p.id, Math.min(p.max, Math.max(p.min, Number(v))));
      set.push(String(p.id));
    }
    // The plugin applies them at its next block; then its state goes into the project, undoable.
    await new Promise((r) => setTimeout(r, 60));
    const key = `${trackId}:${slotId ?? 'instrument'}`;
    const state = await n.getState().catch(() => null);
    if (state) pluginSync.recordEdit(key, pluginName(key), state, { own: false });
    return set;
  }
  const node = (await livePlugin(trackId, slotId)).audioNode;
  const info = await node.getParameterInfo();
  const data: Record<string, { id: string; value: number; normalized: boolean }> = {};
  for (const [id, v] of Object.entries(values)) {
    const p = info[id] ?? Object.values(info).find((x) => (x.label || '').toLowerCase() === id.toLowerCase());
    if (!p) throw new Error(`Unknown parameter "${id}". Call get_plugin_params.`);
    data[p.id] = { id: p.id, value: Math.min(p.maxValue, Math.max(p.minValue, Number(v))), normalized: false };
  }
  await node.setParameterValues(data);
  // The new state goes into the project as a normal (undoable) edit.
  const key = `${trackId}:${slotId ?? 'instrument'}`;
  const state = await node.getState().catch(() => undefined);
  if (state !== undefined) pluginSync.recordEdit(key, pluginName(key), state, { own: false });
  return Object.keys(data);
}

/** Copy every live plugin's state into the project (so saving, reloading and exporting keep it). */
export async function captureWamStates() {
  const p = st().project;
  const instStates = new Map<string, unknown>();
  const slotStates = new Map<string, unknown>();
  for (const t of p.tracks) {
    const c = p.instruments?.find((i) => i.id === t.instrument);
    const live = c?.source === 'wam' ? liveWams.get(`${t.id}:instrument`) : undefined;
    if (c && live && !instStates.has(c.id)) {
      const state = await live.audioNode.getState().catch(() => undefined);
      instStates.set(c.id, state);
      pluginSync.noteCaptured(`${t.id}:instrument`, state);
    }
    for (const s of t.fx?.plugins ?? []) {
      const l = liveWams.get(`${t.id}:${s.id}`);
      if (l) {
        const state = await l.audioNode.getState().catch(() => undefined);
        slotStates.set(s.id, state);
        pluginSync.noteCaptured(`${t.id}:${s.id}`, state);
      }
    }
  }
  // Native plugins (desktop app): their state, as the host saves it.
  const nativeStates = new Map<string, string>();
  for (const [key, n] of allLiveNatives()) {
    const state = await n.getState().catch(() => null);
    if (state) {
      nativeStates.set(key, state);
      pluginSync.noteCaptured(key, state);
    }
  }
  if (!instStates.size && !slotStates.size && !nativeStates.size) return;
  st().commit((d) => {
    for (const i of d.instruments ?? []) if (instStates.has(i.id) && i.wam) i.wam.state = instStates.get(i.id);
    for (const t of d.tracks) for (const s of t.fx?.plugins ?? []) if (slotStates.has(s.id)) s.state = slotStates.get(s.id);
    for (const [key, state] of nativeStates) setProjectPluginState(d, key, state);
  }, { history: false });
}

// ---------- undo of plugin state (F19) ----------

function pluginName(key: string) {
  return projectPluginStates(st().project).get(key)?.name ?? 'plugin';
}

export const pluginSync = new PluginStateSync({
  live: () => {
    const m = new Map<string, LivePlugin>();
    for (const [key, inst] of liveWams) m.set(key, { name: pluginName(key), getState: () => inst.audioNode.getState(), setState: (s) => inst.audioNode.setState(s) });
    // Native plugins: their state travels as base64 through the host.
    for (const [key, n] of allLiveNatives()) m.set(key, { name: n.slot.name, getState: () => n.getState(), setState: (s) => n.setState(s as string) });
    return m;
  },
  project: () => st().project,
  watched: () => {
    const w = st().pluginWindow;
    return w ? `${w.trackId}:${w.slotId ?? 'instrument'}` : null;
  },
  commit: (mutate, label) => st().commit(mutate, { label }),
  beginEdit: (label) => st().beginTransaction(label, 'ui'),
  endEdit: (id) => void st().endTransaction(id),
  isOpen: (id) => st().activeTransaction?.id === id,
  notify: (msg) => st().notify(msg),
});// A native plugin's window changed its state: one undo step, like a WAM's (but told, not polled).
nativeHooks.onDirty = (key, name, b64) => pluginSync.recordEdit(key, name, b64);


// Undo, redo, checkout, load: plugins follow the project.
useStore.subscribe((s, prev) => {
  if (s.project !== prev.project) void pluginSync.projectChanged();
  if (s.past !== prev.past) {
    const trimmed = trimPluginHistory(s.past);
    if (trimmed) useStore.setState({ past: trimmed });
  }
});

if (typeof window !== 'undefined') {
  // GUI edits of the open plugin window.
  setInterval(() => void pluginSync.poll(), 750);
  // Keep plugin states in the autosaved project while people tweak plugin GUIs.
  setInterval(() => {
    if (liveWams.size && !pluginSync.busy) void captureWamStates();
  }, 15000);
}
