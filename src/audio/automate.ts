// Applying effect and plugin automation (F22), the same way live (engine) and offline (render).
import type { Track } from '../types';
import { lanesOf, valueAt } from '../automation';
import type { FxChain } from './fx';
import type { WamInstance } from './wam';

/**
 * A plugin parameter at an audio time: a scheduled `wam-automation` event where the plugin takes
 * events (sample-accurate, also offline), otherwise setParameterValues now.
 */
export function automatePlugin(inst: WamInstance, paramId: string, value: number, time: number) {
  const node = inst.audioNode as WamInstance['audioNode'] & { scheduleEvents?: (...e: unknown[]) => void };
  if (typeof node.scheduleEvents === 'function') node.scheduleEvents({ type: 'wam-automation', data: { id: paramId, value, normalized: false }, time });
  else void node.setParameterValues({ [paramId]: { id: paramId, value, normalized: false } });
}

/** Effect and plugin lanes of a track at `beat`, scheduled at `time`. Mix lanes are handled by the callers. */
export function applyFxAutomation(track: Track, beat: number, time: number, fx: FxChain, instrument: { instance?: WamInstance | null } | undefined, o: { plugins?: boolean } = {}) {
  for (const lane of lanesOf(track)) {
    if (lane.target.kind === 'mix' || !lane.points.length) continue;
    if (lane.target.kind === 'plugin' && o.plugins === false) continue;
    const v = valueAt(lane.points, beat)!;
    if (lane.target.kind === 'fx') fx.setParam(lane.target.unit, lane.target.param, v, time);
    else {
      const inst = lane.target.slotId === null ? instrument?.instance : fx.plugin(lane.target.slotId);
      if (inst) automatePlugin(inst, lane.target.paramId, v, time);
    }
  }
}
