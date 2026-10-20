import { describe, expect, it } from 'vitest';
import { advanceTour, startTour, type TourSnapshot } from './tour';

const snap = (o: Partial<TourSnapshot> = {}): TourSnapshot => ({ playing: false, regions: 3, notes: 20, bottom: 'smart', aiOpen: false, ...o });

describe('tour', () => {
  it('advances only when the right action happens, one step at a time', () => {
    let t = startTour(snap());
    expect(t.step).toBe('play');
    // Wrong actions don't advance.
    t = advanceTour(t, snap({ bottom: 'mixer', aiOpen: true }));
    expect(t.step).toBe('play');
    t = advanceTour(t, snap({ playing: true, bottom: 'mixer', aiOpen: true }));
    expect(t.step).toBe('region'); // only one step, even though mixer and AI are open too
    t = advanceTour(t, snap({ playing: true }));
    expect(t.step).toBe('region'); // no new region yet
    t = advanceTour(t, snap({ regions: 4 }));
    expect(t.step).toBe('note');
    t = advanceTour(t, snap({ regions: 4, notes: 21, bottom: 'smart' }));
    expect(t.step).toBe('note'); // a note added elsewhere doesn't count: in the piano roll
    t = advanceTour(t, snap({ regions: 4, notes: 22, bottom: 'editor' }));
    expect(t.step).toBe('mixer');
    t = advanceTour(t, snap({ regions: 4, notes: 22, bottom: 'mixer' }));
    expect(t.step).toBe('ai');
    t = advanceTour(t, snap({ aiOpen: true }));
    expect(t.step).toBe('done');
    expect(advanceTour(t, snap({ playing: true })).step).toBe('done');
  });
});
