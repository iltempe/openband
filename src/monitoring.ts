// Monitoring essentials (F20): mono sum, dim and the loudness target. What you hear only — exports render
// their own graph and never see these.
import { create } from 'zustand';
import { engine } from './audio/engine';
import { TARGETS, type LoudnessTarget } from './analysis/liveLoudness';

const TARGET_KEY = 'openband.loudnessTarget';
function initialTarget(): LoudnessTarget['id'] {
  try {
    const v = localStorage.getItem(TARGET_KEY);
    if (TARGETS.some((t) => t.id === v)) return v as LoudnessTarget['id'];
  } catch {
    // default
  }
  return 'streaming';
}

export const useMonitoring = create<{ mono: boolean; dim: boolean; target: LoudnessTarget['id'] }>(() => ({ mono: false, dim: false, target: initialTarget() }));

export function setMonitoring(m: Partial<{ mono: boolean; dim: boolean; target: LoudnessTarget['id'] }>) {
  useMonitoring.setState(m);
  engine.setMonitoring({ mono: useMonitoring.getState().mono, dim: useMonitoring.getState().dim });
  if (m.target) {
    try {
      localStorage.setItem(TARGET_KEY, m.target);
    } catch {
      // not kept
    }
  }
}

export const currentTarget = () => TARGETS.find((t) => t.id === useMonitoring.getState().target)!;
