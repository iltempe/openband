// What Firefox's Web Audio lacks and OpenBand needs on a native context (the one Web Audio Modules need, see
// context.ts; Tone's own wrapped contexts fill these in themselves). Without them the studio stopped at
// start in Firefox (issue #8).

// AudioListener has no AudioParams (positionX…upZ), and Tone.js makes a Listener with them for every context
// it is given ("param must be an AudioParam"). Each missing one becomes a real AudioParam that nothing
// listens to — OpenBand places no sound in 3D, so they are never heard.
const DEFAULTS = { positionX: 0, positionY: 0, positionZ: 0, forwardX: 0, forwardY: 0, forwardZ: -1, upX: 0, upY: 1, upZ: 0 };

export function withListenerParams<T extends BaseAudioContext>(ctx: T): T {
  const l = ctx.listener as unknown as Record<string, unknown> | undefined;
  if (!l || 'positionX' in l) return ctx;
  for (const [name, value] of Object.entries(DEFAULTS)) {
    const src = ctx.createConstantSource();
    src.offset.value = value;
    Object.defineProperty(l, name, { value: src.offset, configurable: true });
  }
  return ctx;
}

// AudioParam.cancelAndHoldAtTime (releases, stops, automation): cancel what follows and hold the value. The
// value held is the one now, which for a note released as it is scheduled is the one at that time.
if (typeof AudioParam !== 'undefined' && !('cancelAndHoldAtTime' in AudioParam.prototype)) {
  Object.defineProperty(AudioParam.prototype, 'cancelAndHoldAtTime', {
    configurable: true,
    writable: true,
    value(this: AudioParam, time: number) {
      const v = this.value;
      this.cancelScheduledValues(time);
      this.setValueAtTime(v, time);
      return this;
    },
  });
}
