// For a real cassette (D3.4): each side as one WAV to dub from, with the leader and the gaps. Pure.
import { TAPES } from './burn';

export const LEADER_S = 4;

export function sideLayout(durations: number[], gapS: number, tape: keyof typeof TAPES) {
  const limit = TAPES[tape] * 60;
  const total = LEADER_S + durations.reduce((n, d) => n + d, 0) + Math.max(0, durations.length - 1) * gapS;
  return { totalS: total, limitS: limit, over: total > limit ? total - limit : 0 };
}

/** The songs one after another, on one stereo pair. */
export function assembleSide(songs: Float32Array[][], sampleRate: number, gapS: number) {
  const lead = Math.round(LEADER_S * sampleRate);
  const gap = Math.round(gapS * sampleRate);
  const length = lead + songs.reduce((n, s, i) => n + s[0].length + (i ? gap : 0), 0);
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  let at = lead;
  for (const s of songs) {
    L.set(s[0], at);
    R.set(s[1] ?? s[0], at);
    at += s[0].length + gap;
  }
  return [L, R];
}
