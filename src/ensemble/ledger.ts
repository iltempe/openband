// The contribution ledger, first cut (SPEC v0.6 §6): every region an engine made points to an entry with
// engine, model, seed, licence, the context it was made from and the studio's corrections. From it: the
// human / AI share of each track, the attributions a release must carry, and the licence check.
import type { LedgerEntry, Project } from '../types';
import { BEATS_PER_BAR } from '../music';

/** Ledger entry of a region (and the take that is active, when the entry lists takes). */
export function entryFor(p: Project, regionId: string): LedgerEntry | null {
  const r = p.regions.find((x) => x.id === regionId);
  if (!r?.contribution) return null;
  return p.ledger?.find((e) => e.id === r.contribution) ?? null;
}

export interface Share {
  trackId: string;
  name: string;
  /** Bars of content. */
  bars: number;
  /** 0..1 of those bars made by engines (builtin algorithms included). */
  ai: number;
  engines: string[];
}

/**
 * Human / AI share per track, by bars of content. A region made by an engine counts as AI while the
 * active take is still the engine's; once the user records or writes a take of their own and picks it,
 * that region is the user's again.
 */
export function shares(p: Project): Share[] {
  return p.tracks.map((t) => {
    let total = 0;
    let ai = 0;
    const engines = new Set<string>();
    for (const r of p.regions.filter((x) => x.trackId === t.id)) {
      const bars = r.length / BEATS_PER_BAR;
      total += bars;
      const e = r.contribution ? p.ledger?.find((x) => x.id === r.contribution) : null;
      if (!e) continue;
      const activeIsEngine = !e.takeIds?.length || !r.activeTakeId || e.takeIds.includes(r.activeTakeId);
      if (activeIsEngine) {
        ai += bars;
        engines.add(e.engineName ?? e.engine);
      }
    }
    return { trackId: t.id, name: t.name, bars: +total.toFixed(2), ai: total ? +(ai / total).toFixed(3) : 0, engines: [...engines] };
  });
}

/** Attributions that published songs must carry (e.g. weights under CC BY). */
export const attributions = (p: Project) => [...new Set((p.ledger ?? []).map((e) => e.license.attribution).filter((a): a is string => !!a))];

/** Contributions whose licence forbids commercial use (they block a commercial release). */
export const nonCommercial = (p: Project) => (p.ledger ?? []).filter((e) => e.license.commercial === 'no');
