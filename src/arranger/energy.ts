// Energy over time (G2): the curve the user draws (or a shape: classic pop, slow build, EDM drop, ballad)
// and the one the song has now, measured bar by bar from who plays, how much and how loud. Pure.
import type { MixRole, Project } from '../types';
import { BEATS_PER_BAR } from '../music';
import { noteFacts, roleOf } from '../pilot/roles';

export interface EnergyPoint {
  bar: number;
  energy: number;
}
export interface EnergyCurve {
  points: EnergyPoint[];
  length_bars: number;
  shape?: EnergyShape;
}

export const ENERGY_SHAPES = ['pop', 'slow_build', 'edm_drop', 'ballad'] as const;
export type EnergyShape = (typeof ENERGY_SHAPES)[number];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * A shape as points, for a length in bars (the shape's sections scale with it, in whole 4-bar blocks):
 * pop = intro · verse · chorus · verse · chorus · bridge · chorus · outro; slow build = a steady rise to
 * one peak; EDM = build, drop, breakdown, build, drop; ballad = quiet, a lift, a big last chorus.
 */
export function shapeCurve(shape: EnergyShape, lengthBars: number): EnergyCurve {
  const plans: Record<EnergyShape, [number, number][]> = {
    // [fraction of the song, energy] at each section start
    pop: [[0, 0.2], [0.08, 0.4], [0.25, 0.85], [0.37, 0.45], [0.5, 0.9], [0.62, 0.35], [0.75, 1], [0.92, 0.25]],
    slow_build: [[0, 0.1], [0.2, 0.3], [0.45, 0.5], [0.7, 0.8], [0.85, 1], [0.95, 0.3]],
    edm_drop: [[0, 0.2], [0.12, 0.5], [0.25, 1], [0.45, 0.2], [0.6, 0.6], [0.7, 1], [0.92, 0.2]],
    ballad: [[0, 0.15], [0.1, 0.3], [0.3, 0.55], [0.45, 0.35], [0.6, 0.65], [0.75, 0.9], [0.9, 0.2]],
  };
  const blocks = Math.max(4, Math.round(lengthBars / 4));
  const points: EnergyPoint[] = [];
  const plan = plans[shape];
  plan.forEach(([f, e], i) => {
    const from = Math.round(f * blocks) * 4;
    const to = i + 1 < plan.length ? Math.round(plan[i + 1][0] * blocks) * 4 : blocks * 4;
    if (to <= from) return;
    // Flat inside a section (a step at its start): sections read as sections.
    points.push({ bar: from + 1, energy: e }, { bar: to, energy: e });
  });
  return { points, length_bars: blocks * 4, shape };
}

/** The drawn curve at a bar (1-based), linear between points, flat beyond the ends. */
export function curveAt(c: EnergyCurve, bar: number): number {
  const pts = [...c.points].sort((a, b) => a.bar - b.bar);
  if (!pts.length) return 0.5;
  if (bar <= pts[0].bar) return pts[0].energy;
  for (let i = 1; i < pts.length; i++)
    if (bar <= pts[i].bar) {
      const a = pts[i - 1];
      const b = pts[i];
      return b.bar === a.bar ? b.energy : a.energy + ((b.energy - a.energy) * (bar - a.bar)) / (b.bar - a.bar);
    }
  return pts[pts.length - 1].energy;
}

/** "3:30 at 92 BPM" → bars (4/4). */
export const barsFor = (seconds: number, bpm: number) => Math.max(4, Math.round((seconds * bpm) / 60 / BEATS_PER_BAR / 4) * 4);

/** How much each role adds to a bar's energy when it plays (the sum is 1). */
export const ROLE_WEIGHT: Record<MixRole, number> = { drums: 0.24, kick: 0.06, bass: 0.17, harmony: 0.14, lead: 0.15, vocal: 0.12, texture: 0.08, fx: 0.04 };

/**
 * The song's energy per bar (index 0 = bar 1), 0..1: for each track that plays in the bar, its role's
 * weight × how busy it is (notes per bar against a typical part) × how loud (velocity, fader).
 */
export function measureEnergy(p: Project, bars?: number): number[] {
  const end = Math.max(0, ...p.regions.map((r) => r.start + r.length));
  const n = bars ?? Math.ceil(end / BEATS_PER_BAR);
  const out = new Array(n).fill(0);
  for (const t of p.tracks) {
    if (t.mute) continue;
    const role = roleOf(t, noteFacts(p, t.id));
    const w = ROLE_WEIGHT[role] ?? 0.1;
    const typical = role === 'drums' || role === 'kick' ? 12 : role === 'harmony' || role === 'texture' ? 6 : 5;
    const fader = Math.min(1.25, t.volume / 0.8);
    const perBar = new Array(n).fill(0).map(() => ({ count: 0, vel: 0, audio: false }));
    for (const r of p.regions) {
      if (r.trackId !== t.id) continue;
      if (r.audio) {
        for (let b = Math.floor(r.start / BEATS_PER_BAR); b < Math.ceil((r.start + r.length) / BEATS_PER_BAR) && b < n; b++) if (b >= 0) perBar[b].audio = true;
        continue;
      }
      for (const x of r.notes) {
        if (x.start >= r.length) continue;
        const b = Math.floor((r.start + x.start) / BEATS_PER_BAR);
        if (b < 0 || b >= n) continue;
        perBar[b].count++;
        perBar[b].vel += x.velocity;
      }
    }
    perBar.forEach((x, b) => {
      if (!x.count && !x.audio) return;
      const busy = x.audio ? 0.8 : 0.55 + 0.45 * Math.min(1, x.count / typical);
      const loud = x.audio ? 0.8 : 0.6 + 0.4 * (x.vel / x.count);
      out[b] += w * busy * loud * fader;
    });
  }
  return out.map((v) => +clamp01(v).toFixed(3));
}

/** Pearson correlation of two series (the measured curve against the drawn one). */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
