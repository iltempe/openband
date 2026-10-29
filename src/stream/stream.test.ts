import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, frameBeats, FRAME_SAMPLES, SAMPLE_RATE, StreamProducer } from '../../omep/lib/stream.mjs';
import { JitterBuffer } from './jitter';

/** mulberry32 */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Net {
  /** One-way delay for a message sent at `t` (ms). */
  delay: (t: number) => number;
}

/**
 * A studio and an engine on a simulated network, in 1 ms steps: the studio sends its clock every 50 ms
 * (with the lead its jitter buffer wants and the round trip it measured), the engine makes the frames it
 * owes, every message is delayed by `net` (so they can overtake each other). The stream starts at t0.
 */
function simulate({ minutes, bpm = 120, net, t0 = 1000, change }: { minutes: number; bpm?: number; net: Net; t0?: number; change?: (t: number) => Net | undefined }) {
  let now = 0;
  const producer = new StreamProducer({ now: () => now });
  const jb = new JitterBuffer({ bpm });
  const beatAt = (t: number) => ((t - t0) / 60000) * bpm;
  const inbox: { at: number; run: () => void }[] = [];
  const send = (run: () => void) => inbox.push({ at: now + net.delay(now), run });
  let rtt: number | undefined;
  let clockSeq = 0;
  const end = t0 + minutes * 60000;
  const scheduled: { beat: number; beats: number }[] = [];
  let underrunsAfterWarmup = 0;
  for (; now <= end; now++) {
    const swap = change?.(now);
    if (swap) net = swap;
    if (now % 50 === 0) {
      const msg = { beat: beatAt(now), bpm, playing: true, lead_ms: jb.leadMs, rtt_ms: rtt, sent: now, seq: clockSeq++ };
      send(() => {
        producer.clock(msg);
        send(() => void (rtt = now - msg.sent));
      });
    }
    for (const f of producer.due()) send(() => {
      const ok = jb.arrive({ seq: f.seq, beat: f.beat, beats: frameBeats(f.frames, SAMPLE_RATE, bpm) }, beatAt(now), now);
      if (ok) scheduled.push({ beat: f.beat, beats: frameBeats(f.frames, SAMPLE_RATE, bpm) });
    });
    inbox.sort((a, b) => a.at - b.at);
    while (inbox.length && inbox[0].at <= now) inbox.shift()!.run();
    const before = jb.stats.underruns;
    if (now >= t0) jb.advance(beatAt(now));
    if (now > t0 + 10000) underrunsAfterWarmup += jb.stats.underruns - before;
  }
  scheduled.sort((a, b) => a.beat - b.beat);
  return { stats: jb.stats, scheduled, underrunsAfterWarmup, beats: beatAt(end) };
}

describe('OMEP stream frames', () => {
  it('round-trips PCM with its beat stamp', () => {
    const samples = new Float32Array(FRAME_SAMPLES * 2).map((_, i) => Math.sin(i / 10) * 0.8);
    const f = decodeFrame(encodeFrame({ seq: 41, beat: 12.375, samples }));
    expect(f).toMatchObject({ seq: 41, beat: 12.375, sampleRate: 48000, channels: 2, frames: FRAME_SAMPLES });
    expect(Math.max(...f.samples.map((v, i) => Math.abs(v - samples[i])))).toBeLessThan(1e-4);
    expect(() => decodeFrame(new Uint8Array(30))).toThrow(/Not an OMEP/);
  });

  it('the engine starts on the anchored bar and restarts where the transport jumped', () => {
    let now = 0;
    const p = new StreamProducer({ now: () => now, leadMs: 200 });
    p.clock({ beat: -2, bpm: 120, playing: true });
    const first = p.due();
    expect(first.length).toBe(0); // beat 0 is 1 s away, the lead 200 ms
    now = 850;
    const frames = p.due();
    expect(frames[0]).toMatchObject({ seq: 0, beat: 0 });
    // Contiguous 40 ms frames: 0.08 beats each at 120 BPM.
    expect(frames[1].beat).toBeCloseTo(0.08, 9);
    now = 2000;
    p.clock({ beat: 32, bpm: 120, playing: true, epoch: 1 });
    now = 2100;
    const after = p.due();
    expect(after[0].beat).toBeGreaterThan(32);
    expect(p.restarts).toBe(1);
    p.clock({ beat: 33, bpm: 120, playing: false, epoch: 1 });
    expect(p.due()).toEqual([]);
  });
});

describe('the jitter buffer over a simulated network', () => {
  it('5 minutes of jitter and spikes without one underrun, every frame on its beat', () => {
    const r = rng(7);
    // 30 ms each way, up to 40 ms of jitter, and a 120 ms spike on 1% of the messages.
    const net = { delay: () => 30 + r() * 40 + (r() < 0.01 ? 120 : 0) };
    const { stats, scheduled, beats } = simulate({ minutes: 5, net });
    expect(stats.underruns).toBe(0);
    expect(stats.late).toBe(0);
    // 5 minutes at 120 BPM = 600 beats of continuous audio: no hole, no overlap between frames.
    expect(scheduled.length).toBeGreaterThan(7400);
    for (let i = 1; i < scheduled.length; i++) expect(scheduled[i].beat - (scheduled[i - 1].beat + scheduled[i - 1].beats)).toBeCloseTo(0, 6);
    expect(scheduled.at(-1)!.beat).toBeGreaterThan(beats - 1);
    // The lead settled where this network needs it: above the worst delay, not seconds of it.
    expect(stats.leadMs).toBeLessThan(600);
  });

  it('a network that gets worse: a few frames late, the lead rises, then no more holes', () => {
    const r = rng(11);
    const calm = { delay: () => 5 + r() * 5 };
    const rough = { delay: () => 80 + r() * 150 };
    const { stats, underrunsAfterWarmup } = simulate({ minutes: 2, net: calm, change: (t) => (t === 30000 ? rough : undefined) });
    expect(stats.late).toBeGreaterThan(0);
    expect(stats.leadMs).toBeGreaterThan(250);
    // Holes only around the change: at most a handful, never again in the last minute and a half.
    expect(underrunsAfterWarmup).toBeLessThanOrEqual(3);
  });
});
