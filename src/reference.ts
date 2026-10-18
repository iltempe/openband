// Reference track (F6): import a commercial song, compare the mix with it, A/B them loudness-matched.
import { create } from 'zustand';
import type { Project } from './types';
import { useStore } from './store';
import { engine } from './audio/engine';
import { getBuffer, importSample, onSamplesChanged } from './audio/samples';
import { renderStems } from './audio/render';
import { bandsInWorker, channelsOf, profileInWorker } from './analysis/client';
import { compareProfiles, matchGain, type Comparison, type MasterProfile } from './analysis/reference';
import { audibleTracks, rangeFor, type RangeArgs } from './mixAnalysis';
import { useLang } from './i18n';

export const useReference = create<{ comparison: Comparison | null; mix: MasterProfile | null; ab: boolean; busy: boolean }>(() => ({ comparison: null, mix: null, ab: false, busy: false }));

const st = () => useStore.getState();

function sliceChannels(buf: AudioBuffer, from = 0, to?: number) {
  const a = Math.max(0, Math.floor(from * buf.sampleRate));
  const b = Math.min(buf.length, to !== undefined ? Math.ceil(to * buf.sampleRate) : buf.length);
  if (b - a < buf.sampleRate) throw new Error('The reference excerpt must be at least 1 second long');
  return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(a, b));
}

const publicProfile = ({ third_octaves_db: _, ...rest }: MasterProfile) => rest;

export async function importReference(data: ArrayBuffer, filename: string, from?: number, to?: number) {
  const info = await importSample(data, filename);
  const buf = getBuffer(info.id)!;
  if (from !== undefined && to !== undefined && to <= from) throw new Error('to_seconds must be after from_seconds');
  const profile = await profileInWorker(sliceChannels(buf, from, to), buf.sampleRate);
  st().commit((d) => void (d.reference = { sampleId: info.id, name: filename.replace(/\.[^.]+$/, ''), loudnessMatched: true, from, to, analysis: profile as unknown as Record<string, unknown> }), { label: 'Reference' });
  useReference.setState({ comparison: null });
  return { name: filename, seconds: +(((to ?? info.duration) - (from ?? 0))).toFixed(2), master: publicProfile(profile) };
}

export function clearReference() {
  if (!st().project.reference) return { cleared: false };
  st().commit((d) => void delete d.reference, { label: 'Reference' });
  useReference.setState({ comparison: null, ab: false });
  engine.listenReference(false);
  return { cleared: true };
}

/** Profile of the reference, recomputed if the cached one is missing. */
async function referenceProfile(p: Project): Promise<MasterProfile> {
  const ref = p.reference!;
  if (ref.analysis && 'third_octaves_db' in ref.analysis) return ref.analysis as unknown as MasterProfile;
  const buf = getBuffer(ref.sampleId);
  if (!buf) throw new Error('The reference audio is not loaded (was the project saved without it?)');
  return profileInWorker(sliceChannels(buf, ref.from, ref.to), buf.sampleRate);
}

export async function compareToReference(args: RangeArgs) {
  const p = st().project;
  if (!p.reference) throw new Error('No reference track: call import_reference first');
  const range = rangeFor(p, args);
  const tracks = audibleTracks(p);
  if (!tracks.length) throw new Error('Nothing to compare: the project has no audible tracks');
  useReference.setState({ busy: true });
  try {
    const ref = await referenceProfile(p);
    const rendered = await renderStems(p, { fromBeat: range.fromBeat, toBeat: range.toBeat, tailSeconds: range.whole ? 1 : 0, tracks: tracks.map((t) => t.id) });
    const stems = tracks.map((t) => ({ id: t.id, name: t.name, channels: channelsOf(rendered[t.id]) }));
    const len = stems[0].channels[0].length;
    const mixCh = [new Float32Array(len), new Float32Array(len)];
    for (const s of stems) for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) mixCh[c][i] += s.channels[Math.min(c, s.channels.length - 1)][i];
    const sr = rendered[tracks[0].id].sampleRate;
    const [mix, ...bands] = await Promise.all([profileInWorker(mixCh, sr), ...stems.map((s) => bandsInWorker(s.channels, sr))]);
    const comparison = compareProfiles(mix, ref, stems.map((s, i) => ({ id: s.id, name: s.name, bands_db: bands[i] })), useLang.getState().lang);
    useReference.setState({ comparison, mix, busy: false });
    engine.setReferenceGain(p.reference.loudnessMatched ? matchGain(mix.lufs_integrated, ref.lufs_integrated) : 1);
    const { third_octave_diff_db: _, ...out } = comparison;
    return { range: { from_bar: range.from_bar, to_bar: range.to_bar }, reference: p.reference.name, mix_lufs: mix.lufs_integrated, reference_lufs: ref.lufs_integrated, ...out };
  } catch (e) {
    useReference.setState({ busy: false });
    throw e;
  }
}

/** Switch what you hear between the mix (A) and the reference (B). */
export function setAB(on: boolean) {
  useReference.setState({ ab: on });
  engine.listenReference(on);
}

// Keep the engine's reference player in step with the project.
let loadedRef = '';
function syncReference() {
  const r = st().project.reference;
  const sig = r ? `${r.sampleId}:${r.from}:${r.to}:${!!getBuffer(r.sampleId)}` : '';
  if (sig === loadedRef) return;
  loadedRef = sig;
  const buf = r ? getBuffer(r.sampleId) : undefined;
  if (r && !buf) return;
  engine.setReference(buf ?? null, r?.from ?? 0, r?.to !== undefined ? r.to - (r.from ?? 0) : undefined);
  // Until a comparison has measured the mix, match against its cached loudness using a typical mix level.
  const prof = r?.analysis as unknown as MasterProfile | undefined;
  const mixLufs = useReference.getState().mix?.lufs_integrated ?? -16;
  engine.setReferenceGain(r?.loudnessMatched && prof ? matchGain(mixLufs, prof.lufs_integrated) : 1);
  if (!r) setAB(false);
}

export function initReference() {
  useStore.subscribe((s, prev) => s.project.reference !== prev.project.reference && syncReference());
  onSamplesChanged(syncReference);
}
