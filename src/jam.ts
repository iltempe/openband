// Call-and-response (F15): when should the AI's answer start? Pure scheduling logic.
// The LLM needs seconds to answer, so the reply is quantized to the next useful musical window.
import type { LoopRange } from './types';

export type JamWindow = 'next_bar' | 'next_loop' | { bar: number };

export interface PlanInput {
  /** Playhead now, in beats on the timeline. */
  now: number;
  playing: boolean;
  window: JamWindow;
  loop: LoopRange;
  /** Phrase length in beats. */
  length: number;
  /** Safety margin: never start sooner than this (beats), so the first note isn't late. */
  lead?: number;
  /** A previous answer still plays until this many beats from now (along the playback path). */
  busyFor?: number;
  beatsPerBar?: number;
}

export interface Plan {
  /** Beats to wait, along the playback path (the cycle included). */
  wait: number;
  /** Where the answer starts on the timeline (beats). */
  startBeat: number;
  /** True when the requested window had passed (or was taken) and the next one was used. */
  slipped: boolean;
}

const EPS = 1e-6;
const loopOn = (l: LoopRange) => l.enabled && l.end > l.start;

/** Beats from `now` until the playhead reaches `target`, following the cycle. Infinity if never. */
export function beatsUntil(now: number, target: number, loop: LoopRange): number {
  if (loopOn(loop) && now >= loop.start - EPS && now < loop.end) {
    if (target < loop.start - EPS || target > loop.end + EPS) return Infinity;
    const t = target >= loop.end - EPS ? loop.start : target;
    return t >= now - EPS ? t - now : loop.end - now + (t - loop.start);
  }
  return target >= now - EPS ? target - now : Infinity;
}

/** Timeline beat reached after walking `wait` beats from `now` along the playback path. */
export function beatAfter(now: number, wait: number, loop: LoopRange): number {
  if (!(loopOn(loop) && now >= loop.start - EPS && now < loop.end)) return now + wait;
  const len = loop.end - loop.start;
  const x = now - loop.start + wait;
  return loop.start + (((x % len) + len) % len);
}

/**
 * The start of the answer: the requested window, or the next one if it is too close (within `lead`)
 * or still taken by a previous answer. Always on a bar line (or the loop start), never mid-bar.
 */
export function planResponse(i: PlanInput): Plan {
  const bpb = i.beatsPerBar ?? 4;
  const lead = i.lead ?? 0.5;
  const busy = i.busyFor ?? 0;
  // An answer may start right where the previous one ends (scheduling jitter of a few ms is not overlap).
  const earliest = Math.max(lead, busy - 0.1);
  if (!i.playing) return { wait: 0, startBeat: i.now, slipped: false };

  // Candidate windows in order along the playback path: every bar line ahead (wrapping in the cycle).
  const candidates = function* (): Generator<number> {
    const first = Math.ceil((i.now - EPS) / bpb) * bpb;
    for (let k = 0; k < 64; k++) yield beatsUntil(i.now, first + k * bpb, i.loop);
    if (loopOn(i.loop)) for (let k = 0; k < 64; k++) yield beatsUntil(i.now, i.loop.start, i.loop) + (i.loop.end - i.loop.start) * k;
  };

  let requested: number;
  if (i.window === 'next_loop' && loopOn(i.loop)) requested = beatsUntil(i.now, i.loop.start, i.loop);
  else if (typeof i.window === 'object') requested = beatsUntil(i.now, (Math.max(1, i.window.bar) - 1) * bpb, i.loop);
  else requested = beatsUntil(i.now, Math.ceil((i.now - EPS) / bpb) * bpb, i.loop);

  if (requested >= earliest - EPS && Number.isFinite(requested)) return { wait: requested, startBeat: beatAfter(i.now, requested, i.loop), slipped: false };

  // Too late (or the slot is taken): the next window of the same kind.
  let wait = Infinity;
  if (i.window === 'next_loop' && loopOn(i.loop)) {
    const len = i.loop.end - i.loop.start;
    wait = requested;
    while (wait < earliest - EPS) wait += len;
  } else if (typeof i.window === 'object' && loopOn(i.loop) && Number.isFinite(requested)) {
    // The same bar on the next pass of the cycle.
    const len = i.loop.end - i.loop.start;
    wait = requested;
    while (wait < earliest - EPS) wait += len;
  } else {
    // The next bar line after the earliest moment (bar lines only, so it never lands mid-bar).
    const sorted = [...candidates()].filter(Number.isFinite).sort((a, b) => a - b);
    wait = sorted.find((w) => w >= earliest - EPS) ?? Math.ceil(earliest / bpb) * bpb;
  }
  return { wait, startBeat: beatAfter(i.now, wait, i.loop), slipped: true };
}

/** Phrase length in beats from its notes (at least one bar). */
export const phraseLength = (notes: { start: number; duration: number }[], beatsPerBar = 4) => Math.max(beatsPerBar, Math.ceil(Math.max(0, ...notes.map((n) => n.start + n.duration)) / beatsPerBar) * beatsPerBar);
