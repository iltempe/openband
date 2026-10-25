// Sound-alike for audio tracks (SPEC v0.6 G5): tone match — six peaking EQ bands and the amp's drive that
// bring a track's average spectrum close to a reference's ("make my guitar sound like the record's").
// Where the sounds come from (a sample, an audio region, a stretch of the reference) is resolved here too.
import { useStore } from '../store';
import { getBuffer } from '../audio/samples';
import { stretchFactor } from '../audio/stretch';
import { renderBuffer } from '../audio/render';
import { powerSpectrum } from '../analysis/fft';
import { BEATS_PER_BAR } from '../music';
import type { Project, TrackFx } from '../types';

export interface SoundSource {
  sample_id?: string;
  region_id?: string;
  /** A stretch of the song's reference track (seconds into it). */
  reference_from_seconds?: number;
  to_seconds?: number;
}

/** A sound to match, as mono samples. */
export function resolveSource(s: SoundSource): { x: Float32Array; sampleRate: number; name: string } {
  const p = useStore.getState().project;
  const mono = (b: AudioBuffer, from = 0, to = b.length) => {
    const out = new Float32Array(Math.max(0, to - from));
    for (let c = 0; c < b.numberOfChannels; c++) {
      const ch = b.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += ch[from + i] / b.numberOfChannels;
    }
    return out;
  };
  if (s.region_id) {
    const r = p.regions.find((x) => x.id === s.region_id);
    if (!r?.audio) throw new Error(`"${s.region_id}" is not an audio region`);
    const b = getBuffer(r.audio.sampleId);
    if (!b) throw new Error('The region’s audio is not loaded');
    const from = Math.round(r.audio.offset * b.sampleRate);
    const len = Math.round(((r.length * 60) / p.bpm / stretchFactor(r.audio, p.bpm)) * b.sampleRate);
    return { x: mono(b, from, Math.min(b.length, from + len)), sampleRate: b.sampleRate, name: r.name };
  }
  if (s.reference_from_seconds !== undefined) {
    if (!p.reference) throw new Error('There is no reference track: import one first (import_reference)');
    const b = getBuffer(p.reference.sampleId);
    if (!b) throw new Error('The reference’s audio is not loaded');
    const from = Math.max(0, Math.round(s.reference_from_seconds * b.sampleRate));
    const to = Math.min(b.length, Math.round((s.to_seconds ?? s.reference_from_seconds + 2) * b.sampleRate));
    return { x: mono(b, from, to), sampleRate: b.sampleRate, name: `${p.reference.name} ${s.reference_from_seconds}–${s.to_seconds ?? s.reference_from_seconds + 2} s` };
  }
  if (s.sample_id) {
    const b = getBuffer(s.sample_id);
    if (!b) throw new Error(`Sample "${s.sample_id}" is not loaded`);
    return { x: mono(b), sampleRate: b.sampleRate, name: s.sample_id };
  }
  throw new Error('Give the sound: sample_id, region_id, or reference_from_seconds and to_seconds');
}

/** Third-octave centres from 40 Hz to 16 kHz. */
const CENTRES = Array.from({ length: 27 }, (_, i) => 40 * 2 ** (i / 3));

/** The long-term average spectrum in third-octaves (dB), from the sounding frames. */
export function ltas(x: Float32Array, sr: number): number[] {
  const N = 4096;
  const acc = new Float64Array(N / 2 + 1);
  let frames = 0;
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let at = 0; at + N <= x.length; at += N / 2) {
    let e = 0;
    for (let i = at; i < at + N; i++) e += x[i] * x[i];
    if (Math.sqrt(e / N) < peak * 0.01) continue;
    const p = powerSpectrum(x, at, N);
    for (let k = 0; k < p.length; k++) acc[k] += p[k];
    frames++;
  }
  return CENTRES.map((c) => {
    const lo = Math.max(1, Math.floor((c / 2 ** (1 / 6) / sr) * N));
    const hi = Math.min(N / 2, Math.ceil(((c * 2 ** (1 / 6)) / sr) * N));
    let s = 0;
    for (let k = lo; k <= hi; k++) s += acc[k];
    return 10 * Math.log10(s / Math.max(1, frames) + 1e-14);
  });
}

/** Six peaking bands that turn spectrum `from` into `to` (levels aligned on the mean), ±12 dB. */
export const BANDS = [100, 250, 600, 1500, 4000, 10000];
export function fitBands(from: number[], to: number[]): { hz: number; gain: number; q: number }[] {
  const diff = to.map((v, i) => v - from[i]);
  const mean = diff.reduce((s, v) => s + v, 0) / diff.length;
  return BANDS.map((hz) => {
    const near = CENTRES.map((c, i) => [Math.abs(Math.log2(c / hz)), diff[i] - mean] as const).filter(([d]) => d <= 0.7);
    const g = near.reduce((s, [, v]) => s + v, 0) / Math.max(1, near.length);
    return { hz, gain: +Math.max(-12, Math.min(12, g * 0.8)).toFixed(1), q: 1 };
  });
}

/** How far two spectra are after aligning their levels (dB, mean absolute). */
export function spectralGap(a: number[], b: number[]): number {
  const d = a.map((v, i) => v - b[i]);
  const m = d.reduce((s, v) => s + v, 0) / d.length;
  return d.reduce((s, v) => s + Math.abs(v - m), 0) / d.length;
}

/** Tone match: the drive (tried from 0 to 0.8) and the bands that bring the track closest to the reference. */
export async function toneMatch(trackId: string, ref: { x: Float32Array; sampleRate: number }, o: { from_bar?: number; to_bar?: number; apply?: boolean } = {}) {
  const st = useStore.getState();
  const p0 = st.project;
  const track = p0.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track "${trackId}" not found`);
  const target = ltas(ref.x, ref.sampleRate);
  const regions = p0.regions.filter((r) => r.trackId === trackId);
  if (!regions.length) throw new Error(`"${track.name}" has nothing to match yet`);
  const fromBeat = o.from_bar ? (o.from_bar - 1) * BEATS_PER_BAR : Math.min(...regions.map((r) => r.start));
  const toBeat = o.to_bar ? o.to_bar * BEATS_PER_BAR : Math.min(fromBeat + 8 * BEATS_PER_BAR, Math.max(...regions.map((r) => r.start + r.length)));
  const fx0 = (track.fx ?? {}) as Partial<TrackFx>;
  const withFx = (drive: number): Project => ({
    ...p0,
    tracks: p0.tracks.map((t) =>
      t.id !== trackId
        ? t
        : ({ ...t, fx: { ...fx0, amp: { on: drive > 0, drive, tone: fx0.amp?.tone ?? 0.5, level: fx0.amp?.level ?? 0.7 }, eq: { on: fx0.eq?.on ?? false, low: fx0.eq?.low ?? 0, mid: fx0.eq?.mid ?? 0, high: fx0.eq?.high ?? 0, midFreq: fx0.eq?.midFreq ?? 1000, hpf: fx0.eq?.hpf, bands: [] }, comp: fx0.comp ?? { on: false, threshold: -18, ratio: 3, attack: 0.01, release: 0.2, makeup: 0 } } as TrackFx }),
    ),
  });
  let best: { drive: number; bands: ReturnType<typeof fitBands>; gap: number; before: number } | null = null;
  for (const drive of [0, 0.2, 0.4, 0.6, 0.8]) {
    const buf = await renderBuffer(withFx(drive), { tracks: [trackId], fromBeat, toBeat, includeMaster: false });
    const mine = ltas(buf.getChannelData(0), buf.sampleRate);
    const bands = fitBands(mine, target);
    // What the bands leave: approximated by applying their gains to the bands' neighbourhoods.
    const after = mine.map((v, i) => v + bands.reduce((s, b) => s + b.gain * Math.exp(-((Math.log2(CENTRES[i] / b.hz) / 0.6) ** 2)), 0));
    const gap = spectralGap(after, target);
    if (!best || gap < best.gap) best = { drive, bands, gap, before: spectralGap(mine, target) };
  }
  const r = best!;
  if (o.apply !== false)
    st.commit((d) => {
      const t = d.tracks.find((x) => x.id === trackId)!;
      const fx = (t.fx ?? withFx(0).tracks.find((x) => x.id === trackId)!.fx) as TrackFx;
      t.fx = { ...fx, amp: { on: r.drive > 0, drive: r.drive, tone: fx.amp?.tone ?? 0.5, level: fx.amp?.level ?? 0.7 }, eq: { ...fx.eq, bands: r.bands } };
    });
  return { track_id: trackId, drive: r.drive, bands: r.bands, gap_db: { before: +r.before.toFixed(1), after: +r.gap.toFixed(1) }, applied: o.apply !== false };
}
