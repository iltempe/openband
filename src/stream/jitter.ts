// The studio's side of an OMEP stream (omep/lib/stream.mjs): which frames can still be played on time,
// where the stream had holes (underruns), and how far ahead the engine should work (lead) for the network
// it is on. Pure: beats in, decisions out — the live player (liveJam.ts) and the 5-minute simulation in
// the tests use the same code.

export interface FrameInfo {
  seq: number;
  /** Stream beat where the frame's first sample sounds. */
  beat: number;
  /** Its length in beats. */
  beats: number;
}

export interface JitterStats {
  received: number;
  played: number;
  late: number;
  duplicates: number;
  underruns: number;
  leadMs: number;
  /** The smallest margin (ms between arrival and when the frame sounds) over the recent window. */
  minMarginMs: number | null;
}

export class JitterBuffer {
  /** Ms before a frame sounds under which it can no longer be scheduled reliably. */
  readonly safetyMs: number;
  /** The margin we want to keep above safety, for the next spike. */
  readonly cushionMs: number;
  leadMs: number;
  private readonly minLead: number;
  private readonly maxLead: number;
  private bpm: number;
  private seen = new Set<number>();
  /** Accepted frames not yet passed by the playhead, by beat. */
  private ahead: FrameInfo[] = [];
  /** Where continuous audio ends: the end of the last frame the playhead went through (null before the first). */
  private coveredTo: number | null = null;
  private starving = false;
  private margins: { at: number; ms: number }[] = [];
  private lastLower = 0;
  stats: JitterStats;

  constructor({ bpm, leadMs = 250, safetyMs = 15, cushionMs = 25, minLeadMs = 60, maxLeadMs = 2000 }: { bpm: number; leadMs?: number; safetyMs?: number; cushionMs?: number; minLeadMs?: number; maxLeadMs?: number }) {
    this.bpm = bpm;
    this.leadMs = leadMs;
    this.safetyMs = safetyMs;
    this.cushionMs = cushionMs;
    this.minLead = minLeadMs;
    this.maxLead = maxLeadMs;
    this.stats = { received: 0, played: 0, late: 0, duplicates: 0, underruns: 0, leadMs, minMarginMs: null };
  }

  private ms(beats: number) {
    return (beats * 60000) / this.bpm;
  }

  setBpm(bpm: number) {
    if (bpm > 0) this.bpm = bpm;
  }

  /**
   * A frame arrived while the playhead is at `nowBeat` (with `nowMs`, any monotonic clock, for the lead's
   * window). True: schedule it at its beat. False: too late (or a duplicate) — drop it.
   */
  arrive(f: FrameInfo, nowBeat: number, nowMs: number): boolean {
    this.stats.received++;
    if (this.seen.has(f.seq)) {
      this.stats.duplicates++;
      return false;
    }
    this.seen.add(f.seq);
    if (this.seen.size > 4096) this.seen = new Set([...this.seen].slice(-2048));
    const margin = this.ms(f.beat - nowBeat);
    this.margins.push({ at: nowMs, ms: margin });
    this.adapt(nowMs, margin);
    if (margin < this.safetyMs) {
      this.stats.late++;
      return false;
    }
    let i = this.ahead.length;
    while (i > 0 && this.ahead[i - 1].beat > f.beat) i--;
    this.ahead.splice(i, 0, f);
    this.stats.played++;
    return true;
  }

  /**
   * Raise the lead at once when the margin gets thin; lower it slowly, and only when the worst margin of the
   * last 30 s (spikes included — networks have them every few seconds) stays wide.
   */
  private adapt(nowMs: number, margin: number) {
    while (this.margins.length && this.margins[0].at < nowMs - 30000) this.margins.shift();
    const min = Math.min(...this.margins.map((m) => m.ms));
    this.stats.minMarginMs = +min.toFixed(1);
    const want = this.safetyMs + this.cushionMs;
    if (margin < want) this.leadMs = Math.min(this.maxLead, this.leadMs + (want - margin) + 10);
    else if (min > 2 * want && nowMs - this.lastLower > 5000 && this.margins.length > 250) {
      this.leadMs = Math.max(this.minLead, this.leadMs - Math.min(10, (min - 1.5 * want) / 2));
      this.lastLower = nowMs;
    }
    this.stats.leadMs = Math.round(this.leadMs);
  }

  /**
   * The playhead moved to `nowBeat`: count an underrun for every stretch where it ran past the audio it
   * had (a hole between frames, or nothing yet). Before the first frame there is nothing to miss.
   */
  advance(nowBeat: number) {
    const eps = 1e-6;
    while (this.ahead.length && this.ahead[0].beat <= nowBeat) {
      const f = this.ahead.shift()!;
      if (this.coveredTo !== null && f.beat > this.coveredTo + eps && !this.starving) this.stats.underruns++;
      this.starving = false;
      this.coveredTo = Math.max(this.coveredTo ?? f.beat, f.beat + f.beats);
    }
    if (this.coveredTo !== null && nowBeat > this.coveredTo + eps && !this.starving) {
      this.starving = true;
      this.stats.underruns++;
    }
  }

  /** The stream restarted (seek, loop, tempo): forget where it was. */
  reset() {
    this.ahead = [];
    this.coveredTo = null;
    this.starving = false;
  }
}
