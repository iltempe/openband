// Flub markers while recording (F18): F / G (Shift+F / Shift+G with musical typing open) or a MIDI
// pedal mark the playhead. Marks made during a take wait here and are stored together with the
// recorded region, bound to it (and to the take of their loop pass), so undoing the recording also
// takes them away.
import { create } from 'zustand';
import type { Flub, FlubKind, Project, Region, Take } from './types';
import { BEATS_PER_BAR, uid } from './music';
import { useStore } from './store';
import { engine } from './audio/engine';
import { emitStudioEvent } from './events';
import { flubLoop, pedalCC, regionAt, stepFlub, type PedalState } from './flubs';
import { t } from './i18n';

interface Pending {
  flub: Flub;
  /** Loop pass it was made in (cycle recording: one take per pass). */
  pass: number;
}

/** What is recording right now (set by the MIDI and microphone recorders). */
export interface RecTarget {
  trackId?: string;
  pass: () => number;
}

export const useFlubLive = create<{ pending: Pending[]; target: RecTarget | null }>(() => ({ pending: [], target: null }));

export const isRecordingTake = () => useFlubLive.getState().target !== null;

export function beginFlubTake(target: RecTarget) {
  useFlubLive.setState({ target, pending: [] });
}

/**
 * Mark the playhead. While recording the mark waits for the take; otherwise it is stored at once
 * (on the region under it). Returns the flub.
 */
export function markFlub(kind: FlubKind, o: { beat?: number; trackId?: string; text?: string; author?: 'user' | 'ai' } = {}): Flub {
  const live = useFlubLive.getState();
  const s = useStore.getState();
  const beat = +(o.beat ?? engine.position).toFixed(4);
  const trackId = o.trackId ?? live.target?.trackId ?? s.selectedTrackId ?? undefined;
  const flub: Flub = { id: uid('flub'), beat, kind, createdAt: Date.now(), author: o.author ?? 'user', ...(trackId ? { trackId } : {}), ...(o.text ? { text: o.text.slice(0, 200) } : {}) };
  if (live.target && o.beat === undefined) {
    useFlubLive.setState({ pending: [...live.pending, { flub, pass: live.target.pass() }] });
  } else {
    const r = regionAt(s.project, trackId, beat);
    if (r) {
      flub.regionId = r.id;
      if (r.activeTakeId) flub.takeId = r.activeTakeId;
    }
    s.commit((d) => void (d.flubs = [...(d.flubs ?? []), flub]), { label: kind === 'good' ? t('fl.histGood') : t('fl.histFlub') });
  }
  emitStudioEvent({ kind: 'flub', flub_id: flub.id, flub_kind: kind, beat, bar: +(beat / BEATS_PER_BAR + 1).toFixed(2), ...(trackId ? { track_id: trackId } : {}) });
  if (o.author !== 'ai') s.notify(kind === 'good' ? t('fl.markedGood') : t('fl.marked'));
  return flub;
}

/**
 * The take is over: put the waiting marks into `draft` (call inside the commit that adds the
 * region). Marks inside the region are bound to it, and with cycle takes to the take of their pass.
 */
export function bindPendingFlubs(draft: Project, region?: Region, takeForPass?: (pass: number) => Take | undefined) {
  const { pending } = useFlubLive.getState();
  useFlubLive.setState({ pending: [], target: null });
  if (!pending.length) return;
  const out = pending.map(({ flub, pass }) => {
    const f = { ...flub };
    if (region && f.beat >= region.start - 1e-9 && f.beat <= region.start + region.length + 1e-9) {
      f.regionId = region.id;
      f.trackId = region.trackId;
      const take = takeForPass?.(pass);
      if (take) f.takeId = take.id;
    }
    return f;
  });
  draft.flubs = [...(draft.flubs ?? []), ...out];
}

/** A take that produced nothing still keeps its marks (one undo step). */
export function flushPendingFlubs() {
  if (!useFlubLive.getState().pending.length) return void useFlubLive.setState({ target: null });
  useStore.getState().commit((d) => bindPendingFlubs(d), { label: t('fl.histFlub') });
}

/** `]` / `[`: the next or previous mistake, with a 2-bar loop around it. */
export function jumpToFlub(dir: 1 | -1): Flub | null {
  const s = useStore.getState();
  const f = stepFlub(s.project.flubs ?? [], engine.position, dir);
  if (!f) {
    s.notify(t('fl.none'));
    return null;
  }
  goToFlub(f);
  return f;
}

/** Loop the 2 bars around a flub and put the playhead at the loop start (not an undo step). */
export function goToFlub(f: Flub) {
  const loop = flubLoop(f.beat);
  useStore.getState().commit((d) => void (d.loop = { enabled: true, ...loop }), { history: false });
  engine.position = loop.start;
}

// ---------------------------------------------------------------- MIDI pedal

const PEDAL_KEY = 'openband.flubPedal';
function initialPedal(): PedalState {
  try {
    const cc = Number(localStorage.getItem(PEDAL_KEY));
    if (Number.isInteger(cc) && cc >= 0 && cc < 128 && localStorage.getItem(PEDAL_KEY) !== null) return { cc, learning: false };
  } catch {
    // default
  }
  return { cc: 64, learning: false };
}
export const usePedal = create<PedalState>(() => initialPedal());

export const learnPedal = () => usePedal.setState({ learning: true });

/** Called by the MIDI input for every control change. */
export function onControlChange(cc: number, value: number) {
  const r = pedalCC(usePedal.getState(), cc, value, isRecordingTake());
  usePedal.setState(r.state);
  if (r.action === 'learned') {
    try {
      localStorage.setItem(PEDAL_KEY, String(r.state.cc));
    } catch {
      // not kept
    }
    useStore.getState().notify(t('fl.learned', { cc: r.state.cc }));
  }
  if (r.action === 'flub') markFlub('flub');
}
