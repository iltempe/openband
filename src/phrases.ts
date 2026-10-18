// Splits live playing (MIDI keyboard, musical typing) into phrases for the AI. A phrase ends after a
// bar of silence. Pure: times come from the caller.

export interface PhraseNote {
  pitch: number;
  /** Beats from the start of the phrase's first bar, quantized to the grid. */
  start: number;
  duration: number;
  velocity: number;
  /** Unquantized start, same reference. */
  raw_start: number;
}

export interface Phrase {
  /** 1-based bar where the phrase starts (on the song timeline). */
  start_bar: number;
  notes: PhraseNote[];
}

interface Held {
  start: number;
  velocity: number;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

export class PhraseSegmenter {
  private held = new Map<number, Held>();
  private notes: { pitch: number; start: number; end: number; velocity: number }[] = [];
  private lastEnd = -Infinity;
  /** Song position (beats) at the first note, used to place the phrase on the timeline. */
  private anchor: { clock: number; song: number } | null = null;

  constructor(
    private beatsPerBar = 4,
    /** Silence that closes a phrase, in beats (default one bar). */
    private silence = 4,
    private grid = 0.25,
  ) {}

  /**
   * @param clock monotonic time in beats (keeps running when the transport loops or is stopped)
   * @param song  playhead position in beats at that moment
   */
  noteOn(pitch: number, velocity: number, clock: number, song: number) {
    if (!this.anchor) this.anchor = { clock, song };
    this.held.set(pitch, { start: clock, velocity });
  }

  noteOff(pitch: number, clock: number) {
    const h = this.held.get(pitch);
    if (!h) return;
    this.held.delete(pitch);
    this.notes.push({ pitch, start: h.start, end: Math.max(clock, h.start), velocity: h.velocity });
    this.lastEnd = Math.max(this.lastEnd, clock);
  }

  /** Returns the phrase once a bar of silence has passed since the last note ended. */
  poll(clock: number): Phrase | null {
    if (this.held.size || !this.notes.length || clock - this.lastEnd < this.silence) return null;
    return this.flush();
  }

  /** Close the current phrase now (held notes are cut at the last activity). */
  flush(): Phrase | null {
    for (const [pitch, h] of this.held) this.notes.push({ pitch, start: h.start, end: Math.max(this.lastEnd, h.start), velocity: h.velocity });
    this.held.clear();
    if (!this.notes.length || !this.anchor) return this.reset(null);
    const bar = this.beatsPerBar;
    const anchor = this.anchor;
    // The phrase is placed in the bar where its first note fell on the song timeline.
    const offsetInBar = ((anchor.song % bar) + bar) % bar;
    const barClock = anchor.clock - offsetInBar;
    const q = (x: number) => Math.round(x / this.grid) * this.grid;
    const notes = this.notes
      .map((n) => {
        const raw = n.start - barClock;
        return { pitch: n.pitch, start: r4(Math.max(0, q(raw))), duration: r4(Math.max(this.grid, q(n.end - n.start))), velocity: r4(n.velocity), raw_start: r4(raw) };
      })
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    return this.reset({ start_bar: Math.floor(anchor.song / bar) + 1, notes });
  }

  private reset<T>(value: T): T {
    this.notes = [];
    this.held.clear();
    this.lastEnd = -Infinity;
    this.anchor = null;
    return value;
  }
}
