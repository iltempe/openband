// The first-run tour: five steps, each one done by *doing* it (not by clicking "Next").
// Pure: the app passes snapshots of its state; the step advances only when its action happened.

export type TourStep = 'play' | 'region' | 'note' | 'mixer' | 'ai';
export const TOUR_STEPS: TourStep[] = ['play', 'region', 'note', 'mixer', 'ai'];

export interface TourSnapshot {
  playing: boolean;
  regions: number;
  notes: number;
  bottom: string | null;
  aiOpen: boolean;
}

export interface TourState {
  step: TourStep | 'done';
  /** Counts when the current step started (to tell a new region/note from existing ones). */
  base: { regions: number; notes: number };
}

export const startTour = (s: TourSnapshot): TourState => ({ step: 'play', base: { regions: s.regions, notes: s.notes } });

/** Has the action of this step been done? */
export function stepDone(step: TourStep, s: TourSnapshot, base: TourState['base']): boolean {
  switch (step) {
    case 'play':
      return s.playing;
    case 'region':
      return s.regions > base.regions;
    case 'note':
      return s.notes > base.notes && s.bottom === 'editor';
    case 'mixer':
      return s.bottom === 'mixer';
    case 'ai':
      return s.aiOpen;
  }
}

/** Advance by at most one step per snapshot, so each one is seen. */
export function advanceTour(state: TourState, s: TourSnapshot): TourState {
  if (state.step === 'done' || !stepDone(state.step, s, state.base)) return state;
  const next = TOUR_STEPS[TOUR_STEPS.indexOf(state.step) + 1] ?? 'done';
  return { step: next, base: { regions: s.regions, notes: s.notes } };
}
