// The loop library in the app (F24): the manifest, previews at the song's tempo, adding a loop as an
// audio clip that follows the tempo (F23) and, when it has a key, transposed to the song's key.
import * as Tone from 'tone';
import { create } from 'zustand';
import type { AudioClip } from './types';
import { useStore } from './store';
import { getBuffer, importSample, useSamples } from './audio/samples';
import { ensureClipBuffer } from './audio/processed';
import { addAudioRegion } from './importers';
import { engine } from './audio/engine';
import { BEATS_PER_BAR, keyInterval } from './music';
import { searchLoops, validateManifest, type LoopEntry, type LoopManifest } from './loops';

export const useLoops = create<{ manifest: LoopManifest | null; error: string | null; previewing: string | null }>(() => ({ manifest: null, error: null, previewing: null }));

let loading: Promise<LoopManifest> | null = null;
export function loadManifest(): Promise<LoopManifest> {
  loading ??= fetch('./loops/index.json', { cache: 'no-cache' })
    .then((r) => {
      if (!r.ok) throw new Error(`Loop library not available (HTTP ${r.status})`);
      return r.json();
    })
    .then((m: LoopManifest) => {
      const errs = validateManifest(m);
      if (errs.length) throw new Error(`Loop library manifest is invalid: ${errs[0]}`);
      useLoops.setState({ manifest: m, error: null });
      return m;
    })
    .catch((e) => {
      loading = null;
      useLoops.setState({ error: (e as Error).message });
      throw e;
    });
  return loading;
}

export async function findLoops(q: { query?: string; bpm?: number; key?: string; limit?: number }) {
  return searchLoops(await loadManifest(), q);
}

const sampleOf = new Map<string, string>(); // loop id → sample id
/** Download (once) and store the loop's audio. */
async function sampleFor(loop: LoopEntry): Promise<string> {
  const known = sampleOf.get(loop.id) ?? Object.values(useSamples.getState().info).find((i) => i.name === `${loop.id}.wav`)?.id;
  if (known && getBuffer(known)) return known;
  const res = await fetch(loop.url.startsWith('https://') ? loop.url : `./${loop.url}`);
  if (!res.ok) throw new Error(`Could not download the loop (HTTP ${res.status})`);
  const info = await importSample(await res.arrayBuffer(), `${loop.id}.wav`);
  sampleOf.set(loop.id, info.id);
  return info.id;
}

/** How many semitones to move a loop so it sounds in the song's key (same mode only). */
export function keyShift(loopKey: string | undefined, songKey: string): number {
  if (!loopKey) return 0;
  const minor = (k: string) => /m$/.test(k.trim()) && !/maj$/i.test(k.trim());
  if (minor(loopKey) !== minor(songKey)) return 0;
  return keyInterval(loopKey, songKey);
}

export async function addLoop(loopId: string, o: { trackId?: string; startBar?: number; repeat?: number; followTempo?: boolean; matchKey?: boolean } = {}) {
  const m = await loadManifest();
  const loop = m.loops.find((l) => l.id === loopId);
  if (!loop) throw new Error(`Loop "${loopId}" not found. Call search_loops.`);
  const sampleId = await sampleFor(loop);
  const info = useSamples.getState().info[sampleId];
  const p = useStore.getState().project;
  const startBeat = Math.max(0, ((o.startBar ?? Math.floor(engine.position / BEATS_PER_BAR) + 1) - 1) * BEATS_PER_BAR);
  const tx = useStore.getState().beginTransaction(`Loop: ${loop.name}`, 'ui');
  try {
    const region = addAudioRegion(info, { trackId: o.trackId, startBeat, name: loop.name, lengthBeats: o.followTempo === false ? undefined : loop.bars * BEATS_PER_BAR });
    const shift = o.matchKey === false ? 0 : keyShift(loop.key, p.key);
    useStore.getState().commit((d) => {
      const r = d.regions.find((x) => x.id === region.id)!;
      r.audio!.stretch = { mode: o.followTempo === false ? 'off' : 'follow_tempo', originalBpm: loop.bpm };
      if (shift) r.audio!.pitch = shift;
      // A track made for the loop is named after it, not after its file.
      if (!o.trackId) {
        const tr = d.tracks.find((t) => t.id === r.trackId);
        if (tr) tr.name = loop.name;
      }
    });
    const ids = [region.id];
    for (let i = 1; i < Math.max(1, Math.min(16, o.repeat ?? 1)); i++) {
      const copy = { ...structuredClone(useStore.getState().project.regions.find((x) => x.id === region.id)!), id: `${region.id}_${i}`, start: startBeat + i * loop.bars * BEATS_PER_BAR };
      useStore.getState().commit((d) => void d.regions.push(copy));
      ids.push(copy.id);
    }
    return { region_ids: ids, track_id: region.trackId, loop: loop.name, original_bpm: loop.bpm, follows_tempo: o.followTempo !== false, transposed_by: shift, bars: loop.bars * ids.length };
  } finally {
    useStore.getState().endTransaction(tx);
  }
}

// ---------------------------------------------------------------- preview

let preview: Tone.Player | null = null;
export function stopPreview() {
  preview?.stop();
  preview?.dispose();
  preview = null;
  useLoops.setState({ previewing: null });
}

/** Hear a loop at the song's tempo (and key); in time with the song if it is playing. */
export async function previewLoop(loopId: string) {
  if (useLoops.getState().previewing === loopId) return stopPreview();
  stopPreview();
  const m = await loadManifest();
  const loop = m.loops.find((l) => l.id === loopId)!;
  useLoops.setState({ previewing: loopId });
  const sampleId = await sampleFor(loop);
  const p = useStore.getState().project;
  const clip: AudioClip = { sampleId, offset: 0, gain: 1, stretch: { mode: 'follow_tempo', originalBpm: loop.bpm }, pitch: keyShift(loop.key, p.key) || undefined };
  const buf = await ensureClipBuffer(clip, p.bpm);
  if (!buf || useLoops.getState().previewing !== loopId) return;
  await engine.unlock();
  preview = new Tone.Player({ url: new Tone.ToneAudioBuffer(buf), loop: true, fadeIn: 0.005, fadeOut: 0.01 }).toDestination();
  // Playing: start on the next bar, in time with the song.
  if (engine.playing) {
    const t = Tone.getTransport();
    const next = t.nextSubdivision('1m');
    preview.start(next);
  } else preview.start();
}
