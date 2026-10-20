// Default settings of the built-in effects (pure, shared by the audio code and the automation model).
import type { TrackFx } from './types';

export const defaultFx = (): TrackFx => ({
  amp: { on: false, drive: 0.45, tone: 0.55, level: 0.7 },
  eq: { on: false, low: 0, mid: 0, high: 0, midFreq: 1000 },
  comp: { on: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.18, makeup: 4 },
});
