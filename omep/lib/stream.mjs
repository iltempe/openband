// OMEP stream 1.0 (SPEC v0.6 §2.5, omep/README.md §8): real-time audio from an engine, outside MCP.
// The `stream.jam` tool opens a session and returns a descriptor; audio and the clock then travel on one
// WebSocket:
//
//   binary  engine → studio   one audio frame: a 24-byte header, then 16-bit PCM, interleaved
//   text    studio → engine   {type:'clock'}  where the studio's transport is now, in stream beats
//                             {type:'control'} style, chords, intensity
//   text    engine → studio   {type:'ready'}, {type:'clock_ack'} (measured latency), {type:'error'}
//
// Time is musical: every frame says the **beat** it must sound at (beats since the stream started, which
// the studio anchors to a bar line). The studio plays it exactly there, whatever the network did on the
// way, so alignment does not depend on latency: latency only decides how far ahead the engine must work
// (lead_ms, which the studio raises when frames arrive with too little margin). No Node or DOM APIs here:
// the studio's page and the engines share this file.

export const STREAM_PROTOCOL = 'omep-stream/1.0';
export const SAMPLE_RATE = 48000;
/** 40 ms at 48 kHz: Magenta RealTime 2's own frame. */
export const FRAME_SAMPLES = 1920;
const MAGIC = 0x314d534f; // "OMS1"
export const HEADER_BYTES = 24;

/**
 * One frame. `samples`: Float32Array, interleaved, frames × channels values in [-1, 1].
 * Header (little-endian): magic u32 · seq u32 · beat f64 · sample rate u32 · channels u16 · epoch u16 (the
 * clock epoch the frame was made for: frames still in flight from before a seek are recognised and dropped).
 */
export function encodeFrame({ seq, beat, sampleRate = SAMPLE_RATE, channels = 2, epoch = 0, samples }) {
  const buf = new ArrayBuffer(HEADER_BYTES + samples.length * 2);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, seq >>> 0, true);
  dv.setFloat64(8, beat, true);
  dv.setUint32(16, sampleRate, true);
  dv.setUint16(20, channels, true);
  dv.setUint16(22, epoch & 0xffff, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(HEADER_BYTES + i * 2, Math.round(v * 32767), true);
  }
  return new Uint8Array(buf);
}

/** A frame from the wire (ArrayBuffer or a Uint8Array view), or an error for anything else. */
export function decodeFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < HEADER_BYTES) throw new Error('Stream frame too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not an OMEP stream frame');
  const channels = dv.getUint16(20, true);
  const n = (bytes.byteLength - HEADER_BYTES) / 2;
  if (!channels || n % channels) throw new Error('Stream frame with a broken length');
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = dv.getInt16(HEADER_BYTES + i * 2, true) / 32767;
  return { seq: dv.getUint32(4, true), beat: dv.getFloat64(8, true), sampleRate: dv.getUint32(16, true), channels, epoch: dv.getUint16(22, true), frames: n / channels, samples };
}

/** How many beats `frames` samples last at `bpm`. */
export const frameBeats = (frames, sampleRate, bpm) => (frames / sampleRate) * (bpm / 60);

/**
 * The engine's side: where the studio's transport is (from its clock messages) and which frames to make
 * next so they arrive `lead_ms` ahead of it. Pure: time comes from `now()` (ms), frames from `render`.
 *
 *   const p = new StreamProducer({ render: (beat, frames, bpm) => Float32Array, now: () => performance.now() });
 *   p.clock(msg)          on every clock message
 *   p.due()               the frames to make now: [{ seq, beat, frames }]
 */
export class StreamProducer {
  constructor({ now, sampleRate = SAMPLE_RATE, frameSamples = FRAME_SAMPLES, leadMs = 250, maxAheadMs = 2000 } = {}) {
    this.now = now;
    this.sampleRate = sampleRate;
    this.frameSamples = frameSamples;
    this.leadMs = leadMs;
    this.maxAheadMs = maxAheadMs;
    this.anchor = null; // { beat, bpm, at } — the studio's beat at engine time `at`
    this.playing = false;
    this.next = null; // the beat of the next frame to make
    this.seq = 0;
    this.restarts = 0;
    this.epoch = 0;
  }

  /** The studio's transport now, extrapolated from its last clock message. */
  beatNow(t = this.now()) {
    if (!this.anchor) return null;
    return this.anchor.beat + (this.playing ? ((t - this.anchor.at) / 60000) * this.anchor.bpm : 0);
  }

  /**
   * A clock message: { beat, bpm, playing, lead_ms, rtt_ms, epoch }. The beat was the studio's when it sent
   * it, so half the round trip it measured is added. A new epoch (the studio moved the transport: a seek,
   * a loop, a new start) restarts the stream there; nothing else does — a late clock message is not a jump.
   */
  clock(msg, t = this.now()) {
    const bpm = Number(msg.bpm) > 0 ? Number(msg.bpm) : this.anchor?.bpm ?? 120;
    const wasPlaying = this.playing;
    const transit = Number.isFinite(msg.rtt_ms) && msg.playing ? Math.max(0, Number(msg.rtt_ms)) / 2 : 0;
    this.anchor = { beat: Number(msg.beat) + (transit / 60000) * bpm, bpm, at: t };
    this.playing = !!msg.playing;
    if (Number.isFinite(msg.lead_ms)) this.leadMs = Math.max(20, Math.min(this.maxAheadMs, Number(msg.lead_ms)));
    const epoch = msg.epoch ?? 0;
    const moved = epoch !== this.epoch;
    this.epoch = epoch;
    if (this.playing && (!wasPlaying || moved || this.next === null)) {
      // The stream starts at beat 0 (the bar the studio anchored), or right ahead of a transport that moved.
      const ahead = this.anchor.beat + (this.leadMs / 60000) * bpm;
      if (this.seq) this.restarts++;
      this.next = this.anchor.beat < 0 && !this.seq ? 0 : Math.max(0, ahead);
    }
    if (!this.playing) this.next = null;
    return { produced_beat: this.next, lead_ms: this.leadMs };
  }

  /** The frames that must exist by now: up to lead_ms past the studio's transport. */
  due(t = this.now()) {
    if (!this.playing || this.next === null) return [];
    const bpm = this.anchor.bpm;
    const step = frameBeats(this.frameSamples, this.sampleRate, bpm);
    const until = this.beatNow(t) + (this.leadMs / 60000) * bpm;
    const out = [];
    while (this.next < until && out.length < 64) {
      out.push({ seq: this.seq++, beat: this.next, frames: this.frameSamples, bpm, epoch: this.epoch });
      this.next += step;
    }
    return out;
  }
}
