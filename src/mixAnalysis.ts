// analyze_mix / detect_key / render_spectrogram: render the song (or a range, or stems), analyse it
// in the worker, keep the last result for the Analysis panel.
import { create } from 'zustand';
import type { Project } from './types';
import { BEATS_PER_BAR } from './music';
import { projectEnd, useStore } from './store';
import { renderBuffer, renderStems } from './audio/render';
import { analyzeInWorker, audioKeyInWorker, channelsOf, spectrogramInWorker } from './analysis/client';
import { keyFromProfile, profileFromNotes, sameKey, sameScale, type KeyResult } from './analysis/key';

export const useAnalysis = create<{ result: Record<string, unknown> | null; running: boolean; error: string | null; spectrogram: string | null }>(() => ({
  result: null,
  running: false,
  error: null,
  spectrogram: null,
}));

export interface RangeArgs {
  from_bar?: number;
  to_bar?: number;
  section_id?: string;
}

/** Beats range for tool arguments: a section, explicit bars (to_bar exclusive), or the whole song. */
export function rangeFor(p: Project, a: RangeArgs) {
  const sec = a.section_id ? p.sections?.find((s) => s.id === a.section_id) : undefined;
  if (a.section_id && !sec) throw new Error(`Section "${a.section_id}" not found. Call get_structure.`);
  const end = Math.max(projectEnd(p), BEATS_PER_BAR);
  const fromBeat = sec ? sec.start : Math.max(0, ((a.from_bar ?? 1) - 1) * BEATS_PER_BAR);
  const toBeat = sec ? sec.start + sec.length : a.to_bar ? Math.max(fromBeat + 1, (a.to_bar - 1) * BEATS_PER_BAR) : end;
  const whole = !sec && a.from_bar === undefined && a.to_bar === undefined;
  return { fromBeat, toBeat, whole, from_bar: fromBeat / BEATS_PER_BAR + 1, to_bar: toBeat / BEATS_PER_BAR + 1 };
}

/** Tracks that sound in the mix (mute/solo respected). */
export function audibleTracks(p: Project) {
  const anySolo = p.tracks.some((t) => t.solo);
  return p.tracks.filter((t) => !t.mute && (!anySolo || t.solo));
}

/** Key from the MIDI notes sounding in a range (drums excluded). */
export function symbolicKey(p: Project, fromBeat = 0, toBeat = Infinity): KeyResult | null {
  const melodic = new Set(p.tracks.filter((t) => t.kind === 'instrument').map((t) => t.id));
  const notes = p.regions
    .filter((r) => melodic.has(r.trackId) && !r.audio)
    .flatMap((r) => r.notes.filter((n) => n.start < r.length).map((n) => ({ ...n, start: r.start + n.start, duration: Math.min(n.duration, r.length - n.start) })))
    .filter((n) => n.start < toBeat && n.start + n.duration > fromBeat);
  return notes.length ? keyFromProfile(profileFromNotes(notes)) : null;
}

export async function analyzeMix(args: RangeArgs & { per_track?: boolean; detail?: 'summary' | 'full' }) {
  const p = useStore.getState().project;
  const range = rangeFor(p, args);
  const tracks = audibleTracks(p);
  if (!tracks.length) throw new Error('Nothing to analyse: the project has no audible tracks');
  useAnalysis.setState({ running: true, error: null });
  try {
    const opts = { fromBeat: range.fromBeat, toBeat: range.toBeat, tailSeconds: range.whole ? 1 : 0 };
    let mix: Float32Array[];
    let stems: { id: string; name: string; channels: Float32Array[] }[] | undefined;
    if (args.per_track !== false) {
      // Renders are linear and deterministic: the mix is exactly the sum of its stems.
      const rendered = await renderStems(p, { ...opts, tracks: tracks.map((t) => t.id) });
      stems = tracks.map((t) => ({ id: t.id, name: t.name, channels: channelsOf(rendered[t.id]) }));
      const len = stems[0].channels[0].length;
      mix = [new Float32Array(len), new Float32Array(len)];
      for (const s of stems) for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) mix[c][i] += s.channels[Math.min(c, s.channels.length - 1)][i];
    } else {
      mix = channelsOf(await renderBuffer(p, opts));
    }
    const result = await analyzeInWorker({
      mix,
      stems,
      sampleRate: 44100,
      bpm: p.bpm,
      detail: args.detail ?? 'summary',
      projectKey: p.key,
      symbolicKey: symbolicKey(p, range.fromBeat, range.toBeat),
      firstBar: Math.floor(range.from_bar),
    });
    const out = { range: { from_bar: +range.from_bar.toFixed(2), to_bar: +range.to_bar.toFixed(2) }, ...result };
    useAnalysis.setState({ result: out, running: false });
    return out;
  } catch (e) {
    useAnalysis.setState({ running: false, error: (e as Error).message });
    throw e;
  }
}

export async function detectKey(source: 'midi' | 'audio' | 'both' = 'both') {
  const p = useStore.getState().project;
  let midi: KeyResult | null = null;
  let audio: KeyResult | null = null;
  if (source !== 'audio') midi = symbolicKey(p);
  const audioTracks = audibleTracks(p).filter((t) => t.kind === 'audio');
  if (source !== 'midi' && audioTracks.length) {
    const buf = await renderBuffer(p, { tracks: audioTracks.map((t) => t.id), tailSeconds: 0 });
    audio = await audioKeyInWorker(channelsOf(buf), buf.sampleRate);
  }
  const best = source === 'audio' ? audio : source === 'midi' ? midi : [midi, audio].filter(Boolean).sort((a, b) => b!.confidence - a!.confidence)[0] ?? null;
  if (!best) throw new Error(source === 'audio' ? 'No audio tracks to analyse' : 'No notes or audio to analyse');
  return { key: best.key, confidence: best.confidence, alternatives: best.alternatives, matches_project_key: sameKey(best.key, p.key), same_scale: sameScale(best.key, p.key), project_key: p.key, ...(source === 'both' ? { from_midi: midi?.key ?? null, from_audio: audio?.key ?? null } : {}) };
}

export async function spectrogram(args: RangeArgs & { track_id?: string; width?: number; height?: number }) {
  const p = useStore.getState().project;
  const range = rangeFor(p, args);
  const track = args.track_id ? p.tracks.find((t) => t.id === args.track_id || t.name.toLowerCase() === String(args.track_id).toLowerCase()) : undefined;
  if (args.track_id && !track) throw new Error(`Track "${args.track_id}" not found`);
  const buf = await renderBuffer(p, { fromBeat: range.fromBeat, toBeat: range.toBeat, tailSeconds: 0, ...(track ? { tracks: [track.id] } : {}) });
  const width = Math.max(256, Math.min(2048, Math.round(args.width ?? 1024)));
  const height = Math.max(128, Math.min(1024, Math.round(args.height ?? 384)));
  const png = await spectrogramInWorker({
    channels: channelsOf(buf),
    sampleRate: buf.sampleRate,
    width,
    height,
    bpm: p.bpm,
    fromBeat: range.fromBeat,
    title: `${track ? track.name : p.name} · bars ${range.from_bar}–${range.to_bar}`,
    sections: (p.sections ?? []).map((s) => ({ name: s.name, startBeat: s.start })),
  });
  useAnalysis.setState({ spectrogram: png });
  return { png_base64: png, width, height, from_bar: range.from_bar, to_bar: range.to_bar };
}
