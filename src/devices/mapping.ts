// From a control's value to a parameter (R3.4). Pure.
export interface DeviceMapping {
  deviceId: string;
  control: string;
  trackId: string;
  /** A key as in set_automation: "volume", "fx:eq.midFreq", "plugin:<slot>:<param>". */
  target: string;
  curve: 'linear' | 'log' | 'exp';
  min: number;
  max: number;
  smoothMs: number;
  /** Write the movement as automation while the song plays. Only audio tracks can be armed, so it's also a choice here. */
  write?: boolean;
}

export function applyCurve(v: number, curve: DeviceMapping['curve']) {
  const x = Math.max(0, Math.min(1, v));
  if (curve === 'exp') return x * x;
  if (curve === 'log') return Math.sqrt(x);
  return x;
}

export const mapValue = (v: number, m: Pick<DeviceMapping, 'curve' | 'min' | 'max'>) => m.min + applyCurve(v, m.curve) * (m.max - m.min);

/** One-pole smoothing with a time constant, independent of the frame rate. */
export function smoother(smoothMs: number) {
  let y: number | null = null;
  return (x: number, dtMs: number) => {
    if (y === null || smoothMs <= 0) return (y = x);
    y += (x - y) * (1 - Math.exp(-dtMs / smoothMs));
    return y;
  };
}

/** Movement as automation points: a point when the value or enough time has moved. Pure. */
export function thinPoints(points: { beat: number; value: number }[], minBeats = 1 / 16, minDelta = 0.002) {
  const out: { beat: number; value: number }[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || (p.beat - last.beat >= minBeats && Math.abs(p.value - last.value) >= minDelta)) out.push(p);
  }
  const end = points[points.length - 1];
  if (end && out[out.length - 1] !== end) out.push(end);
  return out;
}
