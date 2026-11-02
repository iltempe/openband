// Listening to a proposal (C1.4): two renders, level-matched, on one clock, so the switch is instant.
import { create } from 'zustand';
import * as Tone from 'tone';
import { renderBuffer } from '../audio/render';
import { loudness } from '../analysis/loudness';
import { BEATS_PER_BAR } from '../music';
import type { Project } from '../types';

export interface Listening {
  mode: 'ab' | 'changes' | 'toggle' | null;
  /** Which is playing: A/B for a blind test, base/head otherwise. */
  side: 'a' | 'b';
  /** Blind: which version is behind A. Hidden until the vote. */
  aIs: 'base' | 'head';
  voted: 'base' | 'head' | null;
}
export const useListening = create<Listening>(() => ({ mode: null, side: 'a', aIs: 'base', voted: null }));

let stopNow: (() => void) | null = null;
let gains: { a: GainNode; b: GainNode } | null = null;

/** The song with everything untouched turned down, to hear only what changed. */
export function duckedCopy(p: Project, changedTracks: Set<string>, db: number): Project {
  const c = structuredClone(p);
  const f = 10 ** (db / 20);
  for (const t of c.tracks) if (!changedTracks.has(t.id)) t.volume *= f;
  return c;
}

/** The gain that matches b to a, in dB: so the louder one doesn't win. Pure. */
export const levelMatchDb = (aLufs: number, bLufs: number) => (Number.isFinite(aLufs) && Number.isFinite(bLufs) ? aLufs - bLufs : 0);

const toRange = (bars: { from: number; to: number } | null, end: number) => (bars ? { fromBeat: Math.max(0, (bars.from - 1) * BEATS_PER_BAR), toBeat: Math.min(end, bars.to * BEATS_PER_BAR) } : {});

async function play(a: Project, b: Project, range: { from: number; to: number } | null, offsetDbB = true) {
  stopListening();
  const end = (p: Project) => p.regions.reduce((m, r) => Math.max(m, r.start + r.length), 0);
  const [ba, bb] = await Promise.all([renderBuffer(a, { ...toRange(range, end(a)), tailSeconds: 0 }), renderBuffer(b, { ...toRange(range, end(b)), tailSeconds: 0 })]);
  const channels = (x: AudioBuffer) => Array.from({ length: x.numberOfChannels }, (_, c) => x.getChannelData(c));
  const trim = offsetDbB ? levelMatchDb(loudness(channels(ba), ba.sampleRate).integrated, loudness(channels(bb), bb.sampleRate).integrated) : 0;
  const ctx = Tone.getContext().rawContext as unknown as AudioContext;
  await ctx.resume();
  const ga = ctx.createGain();
  const gb = ctx.createGain();
  gb.gain.value = 0;
  ga.connect(ctx.destination);
  const trimNode = ctx.createGain();
  trimNode.gain.value = 10 ** (trim / 20);
  trimNode.connect(gb).connect(ctx.destination);
  const srcA = ctx.createBufferSource();
  const srcB = ctx.createBufferSource();
  srcA.buffer = ba;
  srcB.buffer = bb;
  srcA.loop = srcB.loop = true;
  srcA.connect(ga);
  srcB.connect(trimNode);
  const at = ctx.currentTime + 0.05;
  srcA.start(at);
  srcB.start(at);
  gains = { a: ga, b: gb };
  stopNow = () => {
    srcA.stop();
    srcB.stop();
    ga.disconnect();
    gb.disconnect();
    trimNode.disconnect();
  };
  return trim;
}

export function switchSide(side: 'a' | 'b') {
  if (!gains) return;
  const t = (Tone.getContext().rawContext as unknown as AudioContext).currentTime;
  gains.a.gain.setTargetAtTime(side === 'a' ? 1 : 0, t, 0.005);
  gains.b.gain.setTargetAtTime(side === 'b' ? 1 : 0, t, 0.005);
  useListening.setState({ side });
}

export function stopListening() {
  stopNow?.();
  stopNow = null;
  gains = null;
  useListening.setState({ mode: null });
}

/** A/B blind: a coin decides which is A. */
export async function startBlind(base: Project, head: Project, range: { from: number; to: number } | null, coin = Math.random()) {
  const aIs = coin < 0.5 ? 'base' : 'head';
  await play(aIs === 'base' ? base : head, aIs === 'base' ? head : base, range);
  useListening.setState({ mode: 'ab', side: 'a', aIs, voted: null });
}

/** The vote, turned back into what it means. */
export const voteMeaning = (pick: 'a' | 'b', aIs: 'base' | 'head'): 'base' | 'head' => (pick === 'a' ? aIs : aIs === 'base' ? 'head' : 'base');

/** Only what changed: the bars, one bar of context each side, untouched tracks 12 dB down. */
export async function startChanges(base: Project, head: Project, bars: { from: number; to: number }, changed: Set<string>, db = -12) {
  await play(duckedCopy(base, changed, db), duckedCopy(head, changed, db), { from: Math.max(1, bars.from - 1), to: bars.to + 1 });
  useListening.setState({ mode: 'changes', side: 'b' });
  switchSide('b');
}

export async function startToggle(base: Project, head: Project, range: { from: number; to: number } | null) {
  await play(base, head, range);
  useListening.setState({ mode: 'toggle', side: 'a' });
}
