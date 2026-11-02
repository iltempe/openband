// Audio for the song tests: a render per track, per section. A track that hasn't changed isn't rendered again.
import { renderBuffer } from '../audio/render';
import { loudness, truePeak } from '../analysis/loudness';
import type { Project, Section } from '../types';
import { bandEnergyDb, correlation, lowpass, masking, rmsDb, width } from './dsp';
import { tracksOf, type MeasureFn } from './engine';
import type { Metric, SongTest, TrackRef } from './types';

interface Stem {
  channels: Float32Array[];
  sampleRate: number;
}

const cache = new Map<string, Stem>();
const MAX_CACHED = 64;
/** Tests read it: acceptance says a changed track is the only one rendered again. */
export const renderStats = { renders: 0 };

/** What changes a track's sound: itself, its notes and clips, its instruments, the song's clock and master. */
export function trackHash(p: Project, id: string | null) {
  const regions = id ? p.regions.filter((r) => r.trackId === id) : p.regions;
  const tracks = id ? p.tracks.filter((t) => t.id === id) : p.tracks;
  return JSON.stringify([id, tracks, regions, p.instruments, p.bpm, p.master, p.masterVolume]);
}

async function stem(p: Project, id: string | null): Promise<Stem> {
  const key = trackHash(p, id);
  const hit = cache.get(key);
  if (hit) return hit;
  renderStats.renders++;
  const buf = await renderBuffer(p, { ...(id ? { tracks: [id], includeMaster: false } : {}), sampleRate: 44100, tailSeconds: 0 });
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const s = { channels, sampleRate: buf.sampleRate };
  cache.set(key, s);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return s;
}

const refsOf = (m: Metric): TrackRef[] => [m.of, ...(m.against ? [m.against] : [])];

/** Every stem these tests can ask for, ready before the (synchronous) engine runs. */
export async function prepare(p: Project, tests: SongTest[]) {
  const ids = new Set<string | null>();
  for (const t of tests) {
    const a = t.assert;
    if (a.kind === 'symbolic') continue;
    if (a.kind === 'baseline') p.tracks.forEach((x) => ids.add(x.id));
    else
      for (const m of [a.left, ...(typeof a.right === 'object' && !Array.isArray(a.right) ? [a.right] : [])])
        for (const r of refsOf(m)) {
          if (r === 'master') ids.add(null);
          else tracksOf(p, r).forEach((x) => ids.add(x.id));
        }
  }
  const stems = new Map<string | null, Stem>();
  for (const id of ids) stems.set(id, await stem(p, id));
  return stems;
}

function piece(stems: Map<string | null, Stem>, p: Project, r: TrackRef, s: Section | null): Stem | undefined {
  const parts = r === 'master' ? [stems.get(null)] : tracksOf(p, r).map((t) => stems.get(t.id));
  const have = parts.filter(Boolean) as Stem[];
  if (!have.length) return undefined;
  const sr = have[0].sampleRate;
  const from = s ? Math.floor(((s.start * 60) / p.bpm) * sr) : 0;
  const to = s ? Math.ceil((((s.start + s.length) * 60) / p.bpm) * sr) : Infinity;
  const len = Math.min(to, Math.max(...have.map((x) => x.channels[0].length))) - from;
  if (len <= 0) return undefined;
  const channels = [0, 1].map((c) => {
    const out = new Float32Array(len);
    for (const x of have) {
      const ch = x.channels[c] ?? x.channels[0];
      for (let i = 0; i < len; i++) out[i] += ch[from + i] ?? 0;
    }
    return out;
  });
  return { channels, sampleRate: sr };
}

export const measureWith = (stems: Map<string | null, Stem>, approved?: { project: Project; stems: Map<string | null, Stem> } | null): MeasureFn => (m, s, p) => {
  const source = approved && p === approved.project ? approved.stems : stems;
  const x = piece(source, p, m.of, s);
  if (!x) return undefined;
  const [l, r] = x.channels;
  const sr = x.sampleRate;
  const mono = () => l.map((v, i) => (v + r[i]) / 2);
  switch (m.measure) {
    case 'lufs_i':
    case 'lufs_s_max':
    case 'plr': {
      const st = loudness(x.channels, sr);
      const peak = Math.max(truePeak(l), truePeak(r));
      if (m.measure === 'lufs_i') return Number.isFinite(st.integrated) ? st.integrated : rmsDb(mono());
      return m.measure === 'lufs_s_max' ? st.shortTermMax : peak - st.integrated;
    }
    case 'true_peak':
      return Math.max(truePeak(l), truePeak(r));
    case 'rms':
      return rmsDb(mono());
    case 'band_energy':
      return bandEnergyDb(mono(), m.band!, sr);
    case 'correlation':
      return correlation(l, r);
    case 'width':
      return width(l, r);
    case 'mono_below':
      return correlation(lowpass(l, m.band![1], sr), lowpass(r, m.band![1], sr));
    case 'masking': {
      const other = piece(source, p, m.against!, s);
      return other ? masking(mono(), other.channels[0].map((v, i) => (v + other.channels[1][i]) / 2), m.band!, sr) : undefined;
    }
  }
};
