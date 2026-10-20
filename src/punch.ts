// Punch-in/out, pre-roll and loop recording (F25): the pure part — what to play, what to keep, and how a
// punched take is joined to what was there. No store, no audio.

export interface Punch {
  enabled: boolean;
  /** Beats from the song start. */
  inBeat: number;
  outBeat: number;
  /** Bars played before the punch-in (you hear the song, the recording starts at `in`). */
  preRollBars: number;
}

/**
 * Where the transport starts, and which part of the capture (seconds after the transport start) is kept.
 * Without a punch: a count-in bar of clicks and everything from the start.
 */
export function recordingPlan(o: { startBeat: number; bpm: number; punch?: Punch | null; bars?: number }) {
  const spb = 60 / o.bpm;
  if (o.punch?.enabled) {
    const start = Math.max(0, o.punch.inBeat - o.punch.preRollBars * 4);
    return { transportFrom: start, countInBeats: 0, keepFrom: (o.punch.inBeat - start) * spb, keepTo: (o.punch.outBeat - start) * spb, regionStart: o.punch.inBeat, punched: true };
  }
  const keepTo = o.bars !== undefined ? o.bars * 4 * spb : Infinity;
  return { transportFrom: o.startBeat, countInBeats: 4, keepFrom: 0, keepTo, regionStart: o.startBeat, punched: false };
}

/**
 * A punched take: the original audio with [inSample, outSample) replaced by the new recording, joined by
 * equal-power crossfades of `fade` samples just outside both punch points. `rec` is the new audio from
 * `inSample − fade` on (it was captured with that much lead-in). Outside the crossfades the original is
 * kept exactly.
 */
export function punchComposite(orig: Float32Array, rec: Float32Array, inSample: number, outSample: number, fade: number): Float32Array {
  const out = orig.slice();
  const recAt = (i: number) => {
    const k = i - (inSample - fade);
    return k >= 0 && k < rec.length ? rec[k] : 0;
  };
  const a0 = Math.max(0, inSample - fade);
  const b1 = Math.min(out.length, outSample + fade);
  for (let i = a0; i < b1; i++) {
    let w: number; // weight of the new audio
    if (i < inSample) w = (i - a0 + 0.5) / (inSample - a0);
    else if (i < outSample) w = 1;
    else w = 1 - (i - outSample + 0.5) / (b1 - outSample);
    const g = Math.sin((w * Math.PI) / 2);
    const h = Math.cos((w * Math.PI) / 2);
    out[i] = orig[i] * h + recAt(i) * g;
  }
  return out;
}

/** Loop recording: the capture cut into passes of `pass` samples; a last partial pass counts if ≥ half. */
export function splitPasses(pcm: Float32Array, pass: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < pcm.length; i += pass) {
    const piece = pcm.subarray(i, Math.min(pcm.length, i + pass));
    if (piece.length >= pass * 0.5) {
      const full = new Float32Array(pass);
      full.set(piece);
      out.push(full);
    }
  }
  return out;
}

/** The latency a monitoring player hears (ms), and whether it is worth a warning. */
export function monitorLatency(baseLatency: number, outputLatency: number): { ms: number; noticeable: boolean } {
  const ms = Math.round((baseLatency + outputLatency) * 1000);
  return { ms, noticeable: ms > 12 };
}
