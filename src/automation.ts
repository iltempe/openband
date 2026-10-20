// Automation (F22): lanes of piecewise-linear points, each for a target — a mix parameter (volume, pan,
// tone, reverb, echo), a built-in effect parameter (eq.midFreq, comp.threshold…) or a plugin parameter.
// Before the first point the curve holds the first value, after the last point the last value. Values
// are always in the parameter's own range. Pure: no store, no audio.
import type { AutoParam, AutoPoint, AutoTarget, AutomationLane, FxUnit, Track, TrackFx } from './types';
import { defaultFx } from './fxDefaults';

export interface AutoParamInfo {
  id: AutoParam;
  min: number;
  max: number;
  /** The static (non-automated) value on the track. */
  base: (t: Track) => number;
}

export const AUTO_PARAMS: AutoParamInfo[] = [
  { id: 'volume', min: 0, max: 1, base: (t) => t.volume },
  { id: 'pan', min: -1, max: 1, base: (t) => t.pan },
  { id: 'tone', min: 0, max: 1, base: (t) => t.cutoff },
  { id: 'reverb', min: 0, max: 1, base: (t) => t.reverb },
  { id: 'echo', min: 0, max: 1, base: (t) => t.delay },
];
export const autoParam = (id: AutoParam) => AUTO_PARAMS.find((p) => p.id === id)!;

/** Built-in effect parameters that can be automated, with their native ranges and units. */
export const FX_PARAMS: { unit: FxUnit; param: string; min: number; max: number; units?: string }[] = [
  { unit: 'amp', param: 'drive', min: 0, max: 1 },
  { unit: 'amp', param: 'tone', min: 0, max: 1 },
  { unit: 'amp', param: 'level', min: 0, max: 1 },
  { unit: 'eq', param: 'low', min: -15, max: 15, units: 'dB' },
  { unit: 'eq', param: 'mid', min: -15, max: 15, units: 'dB' },
  { unit: 'eq', param: 'high', min: -15, max: 15, units: 'dB' },
  { unit: 'eq', param: 'midFreq', min: 200, max: 6000, units: 'Hz' },
  { unit: 'comp', param: 'threshold', min: -60, max: 0, units: 'dB' },
  { unit: 'comp', param: 'ratio', min: 1, max: 20 },
  { unit: 'comp', param: 'attack', min: 0.001, max: 1, units: 's' },
  { unit: 'comp', param: 'release', min: 0.01, max: 2, units: 's' },
  { unit: 'comp', param: 'makeup', min: 0, max: 24, units: 'dB' },
];
export const fxParam = (unit: FxUnit, param: string) => FX_PARAMS.find((p) => p.unit === unit && p.param === param);

/** Stable key of a target: `mix:volume`, `fx:eq.midFreq`, `plugin:<slot|instrument>:<paramId>`. */
export function targetKey(t: AutoTarget): string {
  if (t.kind === 'mix') return `mix:${t.param}`;
  if (t.kind === 'fx') return `fx:${t.unit}.${t.param}`;
  return `plugin:${t.slotId ?? 'instrument'}:${t.paramId}`;
}
export function parseTargetKey(k: string): AutoTarget | null {
  const [kind, a, ...rest] = k.split(':');
  if (kind === 'mix' && AUTO_PARAMS.some((p) => p.id === a)) return { kind: 'mix', param: a as AutoParam };
  if (kind === 'fx') {
    const [unit, param] = a.split('.');
    return fxParam(unit as FxUnit, param) ? { kind: 'fx', unit: unit as FxUnit, param } : null;
  }
  if (kind === 'plugin' && a && rest.length) return { kind: 'plugin', slotId: a === 'instrument' ? null : a, paramId: rest.join(':') };
  return null;
}
export const sameTarget = (a: AutoTarget, b: AutoTarget) => targetKey(a) === targetKey(b);
export const mix = (param: AutoParam): AutoTarget => ({ kind: 'mix', param });

/** The range of a target; plugins need their parameter info (min/max), defaults to 0..1. */
export function targetRange(t: AutoTarget, plugin?: { min: number; max: number }): { min: number; max: number } {
  if (t.kind === 'mix') return autoParam(t.param);
  if (t.kind === 'fx') return fxParam(t.unit, t.param) ?? { min: 0, max: 1 };
  return plugin ?? { min: 0, max: 1 };
}

/** Static value of a target on the track (plugins: unknown here). */
export function baseValue(t: Track, target: AutoTarget): number | undefined {
  if (target.kind === 'mix') return autoParam(target.param).base(t);
  if (target.kind === 'fx') {
    const fx = (t.fx ?? defaultFx()) as TrackFx;
    const unit = fx[target.unit] as unknown as Record<string, number>;
    return unit?.[target.param];
  }
  return undefined;
}

// ---------------------------------------------------------------- lanes

export const lanesOf = (t: Track): AutomationLane[] => t.automation ?? [];
export const pointsOf = (t: Track, target: AutoTarget): AutoPoint[] | undefined => lanesOf(t).find((l) => sameTarget(l.target, target))?.points;

/** Replace a target's points (an empty list removes the lane; no lanes left removes the field). */
export function setPoints(t: Track, target: AutoTarget, points: AutoPoint[]) {
  const others = lanesOf(t).filter((l) => !sameTarget(l.target, target));
  const lanes = points.length ? [...others, { target, points: sortPoints([...points]) }] : others;
  if (lanes.length) t.automation = lanes;
  else delete t.automation;
}

export function valueAt(points: AutoPoint[] | undefined, beat: number): number | undefined {
  if (!points?.length) return undefined;
  if (beat <= points[0].beat) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (beat <= b.beat) {
      const a = points[i - 1];
      const span = b.beat - a.beat;
      return span <= 0 ? b.value : a.value + ((beat - a.beat) / span) * (b.value - a.value);
    }
  }
  return points[points.length - 1].value;
}

/** Value of a mix parameter at a song position: the curve if there is one, otherwise the static value. */
export const effectiveValue = (t: Track, param: AutoParam, beat: number) => valueAt(pointsOf(t, mix(param)), beat) ?? autoParam(param).base(t);

export const hasAutomation = (t: Track) => lanesOf(t).some((l) => l.points.length > 0);
export const isAutomated = (t: Track, target: AutoTarget) => !!pointsOf(t, target)?.length;

export const sortPoints = (points: AutoPoint[]) => points.sort((a, b) => a.beat - b.beat);

/** Every point of every lane (structure edits move them all). */
export const allPoints = (t: Track) => lanesOf(t).flatMap((l) => l.points);

/** v2 → v3: `{volume: [...], pan: [...]}` → lanes. */
export function lanesFromRecord(rec: unknown): AutomationLane[] | undefined {
  if (Array.isArray(rec)) return rec as AutomationLane[];
  if (!rec || typeof rec !== 'object') return undefined;
  const lanes: AutomationLane[] = [];
  for (const p of AUTO_PARAMS) {
    const pts = (rec as Record<string, AutoPoint[] | undefined>)[p.id];
    if (Array.isArray(pts) && pts.length) lanes.push({ target: mix(p.id), points: pts.map((x) => ({ beat: Number(x.beat), value: Number(x.value) })) });
  }
  return lanes.length ? lanes : undefined;
}

// ---------------------------------------------------------------- writing (latch / touch)

export type WriteMode = 'off' | 'touch' | 'latch';

/**
 * Write a value at `to` over what was there since `from` (a moving control during playback): the points
 * in (from, to] are replaced by one at `to`. Returns a new list.
 */
export function writeSpan(points: AutoPoint[], from: number, to: number, value: number): AutoPoint[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const kept = points.filter((p) => p.beat <= lo + 1e-9 || p.beat > hi + 1e-9);
  return sortPoints([...kept, { beat: +hi.toFixed(4), value }]);
}

/**
 * Touch released at `at`: the curve goes back to what it was, over `glide` beats (a point with the
 * previous curve's value right after the release).
 */
export function touchRelease(written: AutoPoint[], before: AutoPoint[] | undefined, at: number, fallback: number, glide = 0.25): AutoPoint[] {
  const back = valueAt(before, at + glide) ?? fallback;
  const tail = (before ?? []).filter((p) => p.beat > at + glide + 1e-9);
  const head = written.filter((p) => p.beat <= at + 1e-9);
  return sortPoints([...head, { beat: +(at + glide).toFixed(4), value: back }, ...tail]);
}
