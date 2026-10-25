// What the user likes (SPEC v0.6 §7): blind A/B tests between takes made by different engines teach the
// router. Each ranking becomes pairwise wins (engine, capability, style); a Bradley–Terry model, fitted
// locally, gives each engine a preference 0..1 per capability (and per style when there are enough
// comparisons) with a confidence that grows with the comparisons. Kept in this browser, never sent.
import { create } from 'zustand';

export interface Comparison {
  capability: string;
  style: string;
  winner: string;
  loser: string;
  at: number;
}

const KEY = 'openband.ensemble.taste';
let memory: Comparison[] = [];
const load = (): Comparison[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Comparison[];
  } catch {
    return memory;
  }
};
const save = (list: Comparison[]) => {
  memory = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-2000)));
  } catch {
    // kept for this page only
  }
  useTaste.setState({ version: useTaste.getState().version + 1 });
};

export const useTaste = create<{ version: number }>(() => ({ version: 0 }));
export const comparisons = () => load();

/** Words that name a style, for style-specific preferences ("funk", "lo-fi", "jazz"…). */
const STYLES = ['pop', 'rock', 'funk', 'jazz', 'lo-fi', 'lofi', 'hip-hop', 'trap', 'house', 'techno', 'ambient', 'bossa', 'latin', 'reggae', 'blues', 'soul', 'folk', 'classical', 'cinematic', 'edm', 'metal', 'country'];
export function styleOf(text = ''): string {
  const t = text.toLowerCase();
  const s = STYLES.find((w) => t.includes(w));
  return s === 'lofi' ? 'lo-fi' : s ?? '';
}

/** A ranking (best first) of engines → pairwise wins; ties of the same engine count for nothing. */
export function recordRanking(capability: string, style: string, enginesBestFirst: string[]) {
  const list = load();
  const at = Date.now();
  for (let i = 0; i < enginesBestFirst.length; i++)
    for (let j = i + 1; j < enginesBestFirst.length; j++) {
      if (enginesBestFirst[i] === enginesBestFirst[j]) continue;
      list.push({ capability, style, winner: enginesBestFirst[i], loser: enginesBestFirst[j], at });
    }
  save(list);
}

export function resetTaste() {
  save([]);
}

export interface Preference {
  engine: string;
  /** Bradley–Terry probability of beating an average engine, 0..1 (0.5 with no evidence). */
  score: number;
  comparisons: number;
  wins: number;
  /** ± of the score (a 90 % interval, roughly). */
  interval: number;
}

/** Bradley–Terry strengths (MM algorithm) with a weak prior: one win and one loss against an average engine. */
export function bradleyTerry(cs: Pick<Comparison, 'winner' | 'loser'>[]): Preference[] {
  const engines = [...new Set(cs.flatMap((c) => [c.winner, c.loser]))];
  if (!engines.length) return [];
  const PRIOR = '__average__';
  const all = [...cs, ...engines.flatMap((e) => [{ winner: e, loser: PRIOR }, { winner: PRIOR, loser: e }])];
  const names = [...engines, PRIOR];
  let p: Record<string, number> = Object.fromEntries(names.map((n) => [n, 1]));
  for (let it = 0; it < 200; it++) {
    const next: Record<string, number> = {};
    for (const i of names) {
      const wins = all.filter((c) => c.winner === i).length;
      let den = 0;
      for (const c of all) if (c.winner === i || c.loser === i) den += 1 / (p[c.winner] + p[c.loser]);
      next[i] = wins / Math.max(1e-9, den);
    }
    // Keep the average engine at 1.
    const ref = next[PRIOR];
    for (const n of names) next[n] /= ref;
    const moved = names.reduce((m, n) => Math.max(m, Math.abs(Math.log(next[n] / p[n]))), 0);
    p = next;
    if (moved < 1e-7) break;
  }
  return engines
    .map((e) => {
      const n = cs.filter((c) => c.winner === e || c.loser === e).length;
      const wins = cs.filter((c) => c.winner === e).length;
      const score = p[e] / (p[e] + 1);
      // A rough interval: the binomial standard error of a score from n comparisons (plus the prior's 2).
      const interval = 1.645 * Math.sqrt((score * (1 - score)) / (n + 2));
      return { engine: e, score: +score.toFixed(3), comparisons: n, wins, interval: +interval.toFixed(3) };
    })
    .sort((a, b) => b.score - a.score);
}

/** The preferences the router uses for a capability (and a style, when it has at least 5 comparisons of its own). */
export function preferencesFor(capability: string, style = ''): { prefs: Record<string, number>; confidence: Record<string, number> } {
  const list = load().filter((c) => c.capability === capability);
  const styled = style ? list.filter((c) => c.style === style) : [];
  const use = styled.length >= 5 ? styled : list;
  const ranked = bradleyTerry(use);
  return {
    prefs: Object.fromEntries(ranked.map((r) => [r.engine, r.score])),
    // How sure: 0 with no comparisons, towards 1 with many (10 comparisons → 0.67).
    confidence: Object.fromEntries(ranked.map((r) => [r.engine, r.comparisons / (r.comparisons + 5)])),
  };
}

/** Every capability's ranking, for "Your engines". */
export function tasteByCapability(): { capability: string; ranking: Preference[] }[] {
  const list = load();
  return [...new Set(list.map((c) => c.capability))].map((capability) => ({ capability, ranking: bradleyTerry(list.filter((c) => c.capability === capability)) }));
}
