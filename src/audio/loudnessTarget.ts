// Reaching a loudness target through the limiter (G1): the limiter's input gain is found by rendering,
// measuring the integrated loudness and correcting — at most 3 corrections. Under heavy limiting each dB
// of input gives less than a dB of output, so after the first correction the slope is measured (secant)
// instead of assumed to be 1. Pure: the render is passed in.

export interface TargetResult {
  gainDb: number;
  lufs: number;
  iterations: number;
}

export async function reachLoudness(render: (gainDb: number) => Promise<number> | number, inputLufs: number, target: number, tolerance = 0.3): Promise<TargetResult> {
  if (!Number.isFinite(inputLufs)) return { gainDb: 0, lufs: inputLufs, iterations: 0 };
  let g0 = target - inputLufs;
  let l0 = await render(g0);
  let iterations = 1;
  if (Math.abs(l0 - target) <= tolerance) return { gainDb: g0, lufs: l0, iterations };
  let g1 = g0 + (target - l0);
  let l1 = await render(g1);
  iterations++;
  for (let k = 0; k < 2 && Math.abs(l1 - target) > tolerance; k++) {
    const slope = Math.abs(g1 - g0) > 1e-6 ? (l1 - l0) / (g1 - g0) : 1;
    // A limiter flattens the curve but never inverts it.
    const s = Math.min(1, Math.max(0.05, slope));
    const g2 = g1 + (target - l1) / s;
    g0 = g1;
    l0 = l1;
    g1 = Math.min(g2, g1 + 18);
    l1 = await render(g1);
    iterations++;
  }
  return { gainDb: g1, lufs: l1, iterations };
}
