// Full mix analysis from rendered audio: master metrics, per-track stats, masking, key, issues.
import { loudness } from './loudness';
import { averageSpectrum, bandPowers, bandsDb, BANDS, centroid, mono, thirdOctaves, type BandId } from './spectrum';
import { stereo } from './stereo';
import { bandFrames, masking } from './masking';
import { keyFromProfile, profileFromAudio, sameKey, sameScale, type KeyResult } from './key';
import { mixIssues, type MixIssue } from './issues';

export interface AnalysisInput {
  /** Mix channels (stereo). */
  mix: Float32Array[];
  stems?: { id: string; name: string; channels: Float32Array[] }[];
  sampleRate: number;
  bpm: number;
  detail?: 'summary' | 'full';
  projectKey: string;
  /** Key detected from the MIDI notes (preferred over audio when available). */
  symbolicKey?: KeyResult | null;
  /** Bar number of the first sample (for per-bar statistics of a range). */
  firstBar?: number;
  /** How many masking pairs to return (default 5). */
  maskingTop?: number;
}

const r1 = (x: number) => (Number.isFinite(x) ? +x.toFixed(1) : x === -Infinity ? -999 : 0);

export function analyzeAudio(input: AnalysisInput) {
  const { mix, sampleRate } = input;
  const m = mono(mix);
  const L = loudness(mix, sampleRate);
  const spec = averageSpectrum(m);
  const bands = bandPowers(spec, sampleRate);
  const st = mix.length > 1 ? stereo(mix[0], mix[1], sampleRate) : { correlation: 1, width: 0, widthByBand: {}, monoLossDb: 0 };

  const stems = input.stems ?? [];
  const stemEnergy = stems.map((s) => {
    const sm = mono(s.channels);
    let e = 0;
    for (const x of sm) e += x * x;
    return { s, sm, e };
  });
  const totalE = stemEnergy.reduce((a, b) => a + b.e, 0) || 1;
  const tracks = stemEnergy.map(({ s, sm, e }) => {
    const l = loudness(s.channels, sampleRate);
    const b = bandPowers(averageSpectrum(sm), sampleRate);
    const dominant = (Object.entries(b) as [BandId, number][]).sort((a, c) => c[1] - a[1])[0]?.[0] ?? 'mid';
    return { id: s.id, name: s.name, lufs: r1(l.integrated), lufs_short_max: r1(l.shortTermMax), peak_db: r1(l.samplePeak), dominant_band: dominant, share_of_mix: +(e / totalE).toFixed(2), bands_db: bandsDb(b) };
  });
  const mask = stems.length > 1 ? masking(stemEnergy.map(({ s, sm }) => ({ name: s.name, frames: bandFrames(sm, sampleRate) })), input.maskingTop) : [];

  const detected = input.symbolicKey ?? keyFromProfile(profileFromAudio(m, sampleRate));
  // Relative keys (C / Am) share their notes and can't be told apart reliably: only a different scale is a mismatch.
  const key = detected ? { detected: detected.key, project: input.projectKey, confidence: detected.confidence, matches: sameScale(detected.key, input.projectKey), exact: sameKey(detected.key, input.projectKey) } : undefined;

  const issues: MixIssue[] = mixIssues({
    lufs: L.integrated,
    truePeak: L.truePeak,
    samplePeak: L.samplePeak,
    clipped: L.clipped,
    correlation: st.correlation,
    bands: bandsDb(bands),
    masking: mask,
    trackIds: Object.fromEntries(stems.map((s) => [s.name, s.id])),
    key,
  });

  const result: Record<string, unknown> = {
    master: {
      lufs_integrated: r1(L.integrated),
      lufs_short_max: r1(L.shortTermMax),
      lra: r1(L.lra),
      true_peak_dbtp: r1(L.truePeak),
      sample_peak_db: r1(L.samplePeak),
      rms_db: r1(L.rms),
      crest_db: r1(L.crest),
      clipped_samples: L.clipped,
      correlation: st.correlation,
      width: st.width,
      mono_loss_db: st.monoLossDb,
      centroid_hz: Math.round(centroid(spec, sampleRate)),
      bands_db: bandsDb(bands),
    },
    tracks: tracks.map(({ bands_db, ...t }) => (input.detail === 'full' ? { ...t, bands_db } : t)),
    masking: mask,
    key: key ? { detected: key.detected, project: key.project, confidence: key.confidence, matches_project_key: key.exact, same_scale: key.matches, alternatives: detected!.alternatives } : null,
    issues,
  };
  if (input.detail === 'full') {
    const barSec = (4 * 60) / input.bpm;
    const perBar: { bar: number; lufs: number }[] = [];
    // Momentary values come every 100 ms: average them (in power) per bar.
    const mo = L.momentary;
    for (let b = 0; b * barSec * 10 < mo.length; b++) {
      const slice = mo.slice(Math.floor(b * barSec * 10), Math.floor((b + 1) * barSec * 10)).filter(Number.isFinite);
      const p = slice.reduce((a, x) => a + Math.pow(10, (x + 0.691) / 10), 0) / (slice.length || 1);
      perBar.push({ bar: b + (input.firstBar ?? 1), lufs: slice.length ? r1(-0.691 + 10 * Math.log10(p)) : -999 });
    }
    (result.master as Record<string, unknown>).third_octaves_db = thirdOctaves(spec, sampleRate);
    (result.master as Record<string, unknown>).width_by_band = st.widthByBand;
    result.per_bar = perBar;
    result.bands_hz = Object.fromEntries(BANDS.map((b) => [b.id, [b.lo, b.hi]]));
  }
  return result;
}
