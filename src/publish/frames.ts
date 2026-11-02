/** Which frame shows at clip time t, in order and held at the ends. Pure. */
export const frameIndex = (t: number, fps: number, count: number) => Math.max(0, Math.min(count - 1, Math.floor(t * fps)));
