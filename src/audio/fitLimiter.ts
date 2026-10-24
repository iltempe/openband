// Finding the limiter's input gain that meets a loudness target, by rendering the song (G1): shared by
// set_master_chain and the mix pilot.
import type { MasterChain, Project } from '../types';
import { renderBuffer } from './render';
import { loudness, truePeak } from '../analysis/loudness';
import { reachLoudness } from './loudnessTarget';

const SR = 48000;

export async function measureWith(p: Project, chain: MasterChain | null) {
  const buf = await renderBuffer({ ...p, master: chain ?? undefined }, { sampleRate: SR, tailSeconds: 1 });
  const chs = [buf.getChannelData(0), buf.getChannelData(Math.min(1, buf.numberOfChannels - 1))];
  return { lufs: loudness(chs, SR).integrated, tp: 20 * Math.log10(Math.max(...chs.map((c) => truePeak(c)), 1e-9)) };
}

export interface LimiterFit {
  inputGainDb: number;
  beforeLufs: number;
  lufs: number;
  truePeak: number;
  renders: number;
  reached: boolean;
}

/** The chain's limiter input gain for its target (±0.3 LU); the chain itself is not changed. */
export async function fitLimiter(p: Project, m: MasterChain): Promise<LimiterFit> {
  const before = await measureWith(p, { ...m, limiter: { ...m.limiter, on: false } });
  let tp = -Infinity;
  const r = await reachLoudness(async (gainDb) => {
    const x = await measureWith(p, { ...m, limiter: { ...m.limiter, inputGainDb: gainDb } });
    tp = x.tp;
    return x.lufs;
  }, before.lufs, m.limiter.targetLufs);
  return { inputGainDb: +r.gainDb.toFixed(2), beforeLufs: before.lufs, lufs: r.lufs, truePeak: tp, renders: r.iterations + 1, reached: Math.abs(r.lufs - m.limiter.targetLufs) <= 0.3 };
}

export const outOfReach = (m: MasterChain, lufs: number) =>
  `The target ${m.limiter.targetLufs} LUFS is out of reach without crushing the music: ${lufs.toFixed(1)} LUFS is as loud as the limiter goes. Choose a quieter target, or compress the mix first.`;
