// "Sing over it" (D2.6, D2.5): the listener's take becomes a proposal, on the version they heard. Pure.
import { AUDIO_COLOR, uid } from '../music';
import type { Project } from '../types';

/** How late a clap arrives, from the clicks it answers: the median, so one miss doesn't count. */
export function clapLatency(clicksMs: number[], onsetsMs: number[]) {
  const diffs = clicksMs.flatMap((c) => {
    const near = onsetsMs.filter((o) => o >= c - 50 && o < c + 400).sort((a, b) => Math.abs(a - c) - Math.abs(b - c))[0];
    return near === undefined ? [] : [near - c];
  });
  if (diffs.length < 2) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/** The base with one new audio track: the take, moved earlier by its latency. */
export function withOverdub(base: Project, o: { sampleId: string; name: string; startS: number; durationS: number; latencyMs: number }) {
  const p = structuredClone(base);
  const spb = 60 / p.bpm;
  const trackId = uid('trk');
  p.tracks.push({ id: trackId, name: o.name, kind: 'audio', instrument: 'audio', color: AUDIO_COLOR, volume: 0.8, pan: 0, mute: false, solo: false, reverb: 0.05, delay: 0, cutoff: 1 } as Project['tracks'][number]);
  const late = o.latencyMs / 1000;
  p.regions.push({ id: uid('rgn'), trackId, name: o.name, start: o.startS / spb, length: (o.durationS - late) / spb, notes: [], audio: { sampleId: o.sampleId, offset: late, gain: 1 } });
  return { project: p, trackId };
}
