// Turns mix metrics into readable problems with a concrete suggestion. Messages are English (they
// go to the AI); the UI translates them by `code` with `params`.
import type { BandId } from './spectrum';
import type { MaskingPair } from './masking';

export interface MixIssue {
  severity: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  suggestion: string;
  tracks?: string[];
  params?: Record<string, string | number>;
}

export interface IssueInput {
  lufs: number;
  truePeak: number;
  samplePeak: number;
  clipped: number;
  correlation: number;
  bands: Record<BandId, number>;
  masking: MaskingPair[];
  /** Track name → id, to point issues at tracks. */
  trackIds: Record<string, string>;
  key?: { detected: string; project: string; confidence: number; matches: boolean };
}

const f1 = (x: number) => (x > 0 ? '+' : '') + x.toFixed(1);

export function mixIssues(m: IssueInput): MixIssue[] {
  const out: MixIssue[] = [];
  if (m.clipped > 0) {
    out.push({ severity: 'error', code: 'clipping', params: { n: m.clipped }, message: `${m.clipped} samples clip at 0 dBFS`, suggestion: 'Lower the master or the loudest tracks until nothing reaches 0 dBFS' });
  }
  if (m.truePeak > -1) {
    const by = Math.max(0.5, m.truePeak + 1.5);
    out.push({ severity: m.truePeak > 0 ? 'error' : 'warn', code: 'true_peak_high', params: { tp: f1(m.truePeak), by: by.toFixed(1) }, message: `Peaks at ${f1(m.truePeak)} dBTP`, suggestion: `Lower the master by ${by.toFixed(1)} dB or add a limiter (streaming services want ≤ −1 dBTP)` });
  } else if (m.samplePeak > -0.3) {
    out.push({ severity: 'warn', code: 'low_headroom', params: { peak: f1(m.samplePeak) }, message: `Almost no headroom: sample peak ${f1(m.samplePeak)} dBFS`, suggestion: 'Leave at least 1 dB of headroom on the master' });
  }
  for (const p of m.masking) {
    if (p.band === 'bass' && p.score > 0.6) {
      out.push({ severity: 'warn', code: 'masking_low_end', params: { a: p.a, b: p.b, score: p.score }, tracks: [m.trackIds[p.a], m.trackIds[p.b]].filter(Boolean), message: `${p.a} and ${p.b} cover each other at 60–250 Hz (overlap ${p.score})`, suggestion: `Cut 2–3 dB around 80 Hz on ${p.a} (or ${p.b}), or use sidechain so they take turns` });
    } else if (p.score > 0.75 && p.band !== 'sub') {
      out.push({ severity: 'info', code: 'masking', params: { a: p.a, b: p.b, band: p.band, score: p.score }, tracks: [m.trackIds[p.a], m.trackIds[p.b]].filter(Boolean), message: `${p.a} and ${p.b} compete in the ${p.band} band (overlap ${p.score})`, suggestion: `Give each its own space: EQ a few dB down on one of them in that band, pan them apart, or change one's register` });
    }
  }
  if (m.bands.sub > m.bands.bass + 6) {
    out.push({ severity: 'warn', code: 'too_much_sub', params: { diff: (m.bands.sub - m.bands.bass).toFixed(1) }, message: `Too much sub: 20–60 Hz is ${(m.bands.sub - m.bands.bass).toFixed(1)} dB above the bass band`, suggestion: 'High-pass the instruments that don\'t need sub, or lower the sub bass' });
  }
  if (m.correlation < 0) {
    out.push({ severity: 'error', code: 'phase_mono', params: { corr: m.correlation.toFixed(2) }, message: `Phase problems: L/R correlation ${m.correlation.toFixed(2)}, parts cancel in mono`, suggestion: 'Check stereo-widened or doubled parts and keep bass and kick centred' });
  }
  if (Number.isFinite(m.lufs) && m.lufs < -20) {
    out.push({ severity: 'info', code: 'quiet_mix', params: { lufs: m.lufs.toFixed(1) }, message: `The mix is quiet (${m.lufs.toFixed(1)} LUFS) compared with streaming targets (−14 LUFS)`, suggestion: 'Raise the master or compress gently; keep the true peak under −1 dBTP' });
  }
  if (m.key && !m.key.matches && m.key.confidence > 0.7) {
    out.push({ severity: 'info', code: 'key_mismatch', params: { detected: m.key.detected, project: m.key.project }, message: `The music sounds in ${m.key.detected}, but the project key is ${m.key.project}`, suggestion: `Set the project key to ${m.key.detected} (set_key) or check notes that leave the key` });
  }
  return out;
}
