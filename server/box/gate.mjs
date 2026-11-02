// When a rehearsal starts and stops (R2.4): pure, fed with audio, answers with frame positions.
// RMS over 50 ms windows on all channels. Start: 2 s of sound. Inside a session a pause over 8 s cuts between
// songs. End: 90 s of silence. A channel must fall 3 dB below the threshold to count as quiet (hysteresis).
export const GATE_DEFAULTS = { thresholdDb: -42, startMs: 2000, endMs: 90000, splitMs: 8000, windowMs: 50, releaseDb: 3, preRollS: 5, dropoutMs: 250 };

const dbOf = (sumSquares, n) => (n ? 10 * Math.log10(sumSquares / n + 1e-12) : -120);

export class Gate {
  constructor(o = {}) {
    Object.assign(this, GATE_DEFAULTS, o);
    this.sampleRate = o.sampleRate ?? 48000;
    this.channels = o.channels ?? 2;
    this.windowFrames = Math.round((this.sampleRate * this.windowMs) / 1000);
    this.sums = new Float64Array(this.channels);
    this.filled = 0;
    this.frame = 0; // frames seen
    this.state = 'idle';
    this.soundMs = 0;
    this.quietMs = 0;
    this.soundStart = 0;
    this.lastSound = 0;
    this.loud = false;
  }

  /** @param {Float32Array} interleaved @returns {{ type: 'start'|'split'|'end', at: number }[]} frames from the first ever fed */
  push(interleaved) {
    const out = [];
    const { channels, windowFrames } = this;
    for (let i = 0; i + channels <= interleaved.length; i += channels) {
      for (let c = 0; c < channels; c++) this.sums[c] += interleaved[i + c] ** 2;
      this.frame++;
      if (++this.filled === windowFrames) {
        this.window(out);
        this.sums.fill(0);
        this.filled = 0;
      }
    }
    return out;
  }

  window(out) {
    const level = Math.max(...Array.from(this.sums, (s) => dbOf(s, this.windowFrames)));
    this.level = level;
    this.loud = level > this.thresholdDb - (this.loud ? this.releaseDb : 0);
    if (this.state === 'idle') {
      if (this.loud) {
        if (!this.soundMs) this.soundStart = this.frame - this.windowFrames;
        this.soundMs += this.windowMs;
        this.quietMs = 0;
        if (this.soundMs >= this.startMs) {
          this.state = 'recording';
          this.lastSound = this.frame;
          this.soundMs = 0;
          out.push({ type: 'start', at: Math.max(0, this.soundStart - Math.round(this.preRollS * this.sampleRate)) });
        }
      } else if ((this.quietMs += this.windowMs) > this.dropoutMs) {
        this.soundMs = 0;
        this.quietMs = 0;
      }
      return;
    }
    if (this.loud) {
      if (this.quietMs >= this.splitMs) out.push({ type: 'split', at: Math.round((this.lastSound + this.frame - this.windowFrames) / 2) });
      this.quietMs = 0;
      this.lastSound = this.frame;
      return;
    }
    this.quietMs += this.windowMs;
    if (this.quietMs >= this.endMs) {
      this.state = 'idle';
      this.quietMs = 0;
      out.push({ type: 'end', at: this.lastSound });
    }
  }

  /** The REC button: a session starts or stops now. */
  force(on) {
    if (on && this.state === 'idle') {
      this.state = 'recording';
      this.lastSound = this.frame;
      this.soundMs = 0;
      this.quietMs = 0;
      return { type: 'start', at: Math.max(0, this.frame - Math.round(this.preRollS * this.sampleRate)) };
    }
    if (!on && this.state === 'recording') {
      this.state = 'idle';
      this.quietMs = 0;
      return { type: 'end', at: this.frame };
    }
    return null;
  }
}
