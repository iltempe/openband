// Automation curves: piecewise-linear points per track parameter. Before the first point the curve
// holds the first value, after the last point the last value.
import type { AutoParam, AutoPoint, Track } from './types';

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

/** Value of a parameter at a song position: the curve if there is one, otherwise the static value. */
export const effectiveValue = (t: Track, param: AutoParam, beat: number) => valueAt(t.automation?.[param], beat) ?? autoParam(param).base(t);

export const hasAutomation = (t: Track) => !!t.automation && Object.values(t.automation).some((pts) => pts && pts.length > 0);

export const sortPoints = (points: AutoPoint[]) => points.sort((a, b) => a.beat - b.beat);
