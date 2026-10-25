// A fix for Tone.js (15.0): oscillators with custom partials or a phase (the "fat" unison ones too) share
// one cache of PeriodicWaves across every audio context. A wave made by the live context (48 kHz on many
// machines) and reused by an offline render at another rate (an export at 44.1 kHz) plays at the wrong
// pitch — 1.5 semitones flat at 48 → 44.1 kHz. Here each wave remembers its context, and the cache only
// answers with waves of the oscillator's own.
import * as Tone from 'tone';

const madeBy = new WeakMap<PeriodicWave, BaseAudioContext>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctxProto = Tone.Context.prototype as any;
if (!ctxProto.__obPeriodicWave) {
  ctxProto.__obPeriodicWave = true;
  const create = ctxProto.createPeriodicWave;
  ctxProto.createPeriodicWave = function (this: { rawContext: BaseAudioContext }, ...args: unknown[]) {
    const wave = create.apply(this, args) as PeriodicWave;
    madeBy.set(wave, this.rawContext);
    return wave;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oscProto = Tone.Oscillator.prototype as any;
  const cached = oscProto._getCachedPeriodicWave;
  oscProto._getCachedPeriodicWave = function (this: { context: { rawContext: BaseAudioContext } }) {
    const hit = cached.call(this) as { wave?: PeriodicWave } | undefined;
    return hit?.wave && madeBy.get(hit.wave) !== this.context.rawContext ? undefined : hit;
  };
}

export {};
