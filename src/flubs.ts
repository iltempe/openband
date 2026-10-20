// Flub markers (F18): marks left while recording — a mistake, a good part, a note. Pure: no store,
// no audio; the commands and the recording code apply what these return.
import type { Flub, Project, Region, Take } from './types';
import { BEATS_PER_BAR } from './music';

/** A flub "near" a point: within this many beats. */
export const NEAR_BEATS = 1;

/** The take a flub belongs to: its own, or the region's first take (recorded before takes existed). */
export const takeOf = (f: Flub, r: Region): string | undefined => f.takeId ?? r.takes?.[0]?.id;

/**
 * The best take to use at `beat` (absolute) in a region: among the takes with no `flub` mark within
 * ±1 beat of it, the one with the most `good` marks (then fewer flubs overall, then the newest).
 * Null when every take has a mistake there, or the region has fewer than two takes.
 */
export function bestTakeAt(region: Region, flubs: Flub[], beat: number): Take | null {
  const takes = region.takes ?? [];
  if (takes.length < 2) return null;
  const mine = flubs.filter((f) => f.regionId === region.id);
  const score = (t: Take) => {
    const of = mine.filter((f) => takeOf(f, region) === t.id);
    return { bad: of.some((f) => f.kind === 'flub' && Math.abs(f.beat - beat) <= NEAR_BEATS + 1e-9), good: of.filter((f) => f.kind === 'good').length, flubs: of.filter((f) => f.kind === 'flub').length };
  };
  const ranked = takes
    .map((t) => ({ t, ...score(t) }))
    .filter((x) => !x.bad)
    .sort((a, b) => b.good - a.good || a.flubs - b.flubs || b.t.createdAt - a.t.createdAt);
  return ranked[0]?.t ?? null;
}

/** The stretch to replace around a point (beats from the region start): the bars covering ±1 beat. */
export function fixWindow(region: Region, beat: number): { from: number; to: number } {
  const rel = beat - region.start;
  const from = Math.max(0, Math.floor((rel - NEAR_BEATS) / BEATS_PER_BAR) * BEATS_PER_BAR);
  const to = Math.min(region.length, Math.ceil((rel + NEAR_BEATS) / BEATS_PER_BAR) * BEATS_PER_BAR);
  return { from, to: Math.max(to, Math.min(region.length, from + BEATS_PER_BAR)) };
}

/** Next (dir 1) or previous (dir −1) unresolved flub from `pos`; wraps around. */
export function stepFlub(flubs: Flub[], pos: number, dir: 1 | -1): Flub | null {
  const open = flubs.filter((f) => !f.resolved && f.kind === 'flub').sort((a, b) => a.beat - b.beat);
  if (!open.length) return null;
  const eps = 1e-6;
  if (dir === 1) return open.find((f) => f.beat > pos + eps) ?? open[0];
  return [...open].reverse().find((f) => f.beat < pos - eps) ?? open[open.length - 1];
}

/** The 2-bar loop around a flub: it sits in the first bar if it is late in its bar, else in the second. */
export function flubLoop(beat: number): { start: number; end: number } {
  const bar = Math.floor(beat / BEATS_PER_BAR) * BEATS_PER_BAR;
  const start = Math.max(0, beat - bar < BEATS_PER_BAR / 2 ? bar - BEATS_PER_BAR : bar);
  return { start, end: start + 2 * BEATS_PER_BAR };
}

/**
 * After an edit, flubs follow their region: moved → same offset, other track → that track, deleted →
 * the flub stays where it was without the link (a deleted take loses its take link).
 */
export function followRegions(prev: Project, draft: Project) {
  if (!draft.flubs?.length) return;
  const before = new Map(prev.regions.map((r) => [r.id, r]));
  const after = new Map(draft.regions.map((r) => [r.id, r]));
  for (const f of draft.flubs) {
    if (!f.regionId) continue;
    const a = after.get(f.regionId);
    if (!a) {
      delete f.regionId;
      delete f.takeId;
      continue;
    }
    const b = before.get(f.regionId);
    if (b && b.start !== a.start) f.beat = +(f.beat + a.start - b.start).toFixed(4);
    f.trackId = a.trackId;
    if (f.takeId && !a.takes?.some((t) => t.id === f.takeId)) delete f.takeId;
  }
}

/** The region (and its active take) under a beat on a track, for marks made outside a recording. */
export function regionAt(p: Project, trackId: string | undefined, beat: number): Region | undefined {
  if (!trackId) return undefined;
  return p.regions.find((r) => r.trackId === trackId && beat >= r.start - 1e-9 && beat <= r.start + r.length + 1e-9);
}

// ---------------------------------------------------------------- MIDI pedal

export interface PedalState {
  /** Controller number that marks a flub (default 64, the sustain pedal). */
  cc: number;
  /** Waiting for the next controller to learn it. */
  learning: boolean;
  /** The pedal is down (marks only on the way down, not while held or for each value of a sweep). */
  down?: boolean;
}

/**
 * One MIDI control change. Learning: the controller moved becomes the flub pedal. Otherwise the
 * pedal going down (crossing 64) marks a flub — only while recording.
 */
export function pedalCC(state: PedalState, cc: number, value: number, recording: boolean): { state: PedalState; action: 'learned' | 'flub' | null } {
  if (state.learning) return value > 0 ? { state: { cc, learning: false, down: value >= 64 }, action: 'learned' } : { state, action: null };
  if (cc !== state.cc) return { state, action: null };
  const down = value >= 64;
  const action = down && !state.down && recording ? 'flub' : null;
  return { state: { ...state, down }, action };
}
