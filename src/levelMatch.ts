// Level-matched A/B (F20): an effect that makes things louder always sounds "better". Measure the
// short-term loudness (3 s) of a track with and without its chain (or one plugin), and compare them at
// the same loudness — or make the compensation permanent with the chain's output trim.
import { create } from 'zustand';
import { loudness } from './analysis/loudness';
import { renderBuffer } from './audio/render';
import { engine } from './audio/engine';
import { useStore, getTrack } from './store';
import { BEATS_PER_BAR } from './music';
import { t } from './i18n';

const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));

export interface LevelMatch {
  track_id: string;
  slot_id: string | null;
  /** Loudness the chain adds (+) or takes away (−), dB. */
  gain_change_db: number;
  with_lufs: number;
  without_lufs: number;
  from_bar: number;
  message: string;
  applied?: boolean;
}

/** The comparison from two renders of the same 3 s: with and without the effect. */
export function compareLoudness(withFx: Float32Array[], withoutFx: Float32Array[], fs: number): { gain: number; with: number; without: number } {
  const a = loudness(withFx, fs).shortTermMax;
  const b = loudness(withoutFx, fs).shortTermMax;
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Nothing plays on this track there: move the playhead to where it plays');
  return { gain: +(a - b).toFixed(2), with: +a.toFixed(1), without: +b.toFixed(1) };
}

export function levelMessage(gain: number, plugin: boolean): string {
  const what = plugin ? t('lm.plugin') : t('lm.chain');
  if (Math.abs(gain) < 0.3) return t('lm.same', { what });
  return t(gain > 0 ? 'lm.louder' : 'lm.quieter', { what, db: (gain > 0 ? '+' : '') + gain.toFixed(1).replace('.', t('lm.decimal')) });
}

/** Where to listen: the playhead if the track plays there, else its first region. */
function startBeat(trackId: string): number {
  const p = useStore.getState().project;
  const regions = p.regions.filter((r) => r.trackId === trackId).sort((a, b) => a.start - b.start);
  if (!regions.length) throw new Error('This track has nothing to play');
  const pos = engine.position;
  return regions.some((r) => pos >= r.start && pos < r.start + r.length) ? pos : regions[0].start;
}

export async function levelMatch(trackId: string, slotId: string | null = null, apply = false): Promise<LevelMatch> {
  const s = useStore.getState();
  const track = getTrack(s.project, trackId);
  if (!track) throw new Error(`Track "${trackId}" not found`);
  if (slotId && !track.fx?.plugins?.some((x) => x.id === slotId)) throw new Error(`Plugin slot "${slotId}" not found on this track`);
  const p = s.project;
  const from = startBeat(track.id);
  const to = from + (3 * p.bpm) / 60;
  const base = { fromBeat: from, toBeat: to, tracks: [track.id], includeMaster: false, tailSeconds: 0 };
  const [withFx, withoutFx] = await Promise.all([renderBuffer(p, base), renderBuffer(p, { ...base, bypass: { trackId: track.id, slotId } })]);
  const r = compareLoudness(channelsOf(withFx), channelsOf(withoutFx), withFx.sampleRate);
  const out: LevelMatch = { track_id: track.id, slot_id: slotId, gain_change_db: r.gain, with_lufs: r.with, without_lufs: r.without, from_bar: +(from / BEATS_PER_BAR + 1).toFixed(2), message: levelMessage(r.gain, !!slotId) };
  useLevelMatch.setState({ results: { ...useLevelMatch.getState().results, [`${track.id}:${slotId ?? ''}`]: out } });
  if (apply) {
    applyCompensation(track.id, r.gain);
    out.applied = true;
  }
  return out;
}

/** Make the compensation permanent: the chain's output trim takes back what the effect added. */
export function applyCompensation(trackId: string, gainDb: number) {
  useStore.getState().commit(
    (d) => {
      const tr = d.tracks.find((x) => x.id === trackId);
      if (!tr) return;
      tr.fx = { ...(tr.fx ?? ({} as never)), trim: +((tr.fx?.trim ?? 0) - gainDb).toFixed(2) };
    },
    { label: t('lm.hist') },
  );
}

/** Results by `${trackId}:${slotId}`, and which comparison is being heard (bypassed side). */
export const useLevelMatch = create<{ results: Record<string, LevelMatch>; hearing: string | null }>(() => ({ results: {}, hearing: null }));

/** Toggle hearing the effect bypassed at the same loudness (B) vs the normal chain (A). */
export function toggleMatchedBypass(trackId: string, slotId: string | null) {
  const key = `${trackId}:${slotId ?? ''}`;
  const res = useLevelMatch.getState().results[key];
  if (!res) return;
  const prev = useLevelMatch.getState().hearing;
  // Only one comparison at a time: put the previous one back first.
  if (prev) engine.fxChain(prev.split(':')[0])?.setCompare(null);
  if (prev === key) return void useLevelMatch.setState({ hearing: null });
  // Bypassed and turned up by what the effect adds: both sides at the same loudness.
  engine.fxChain(trackId)?.setCompare({ slotId, gainDb: res.gain_change_db });
  useLevelMatch.setState({ hearing: key });
}
