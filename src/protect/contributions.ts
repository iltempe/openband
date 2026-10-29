// The contribution ledger in the work's manifest (SPEC v0.6 §6 → G7): the human / AI share of each track,
// the engines whose parts are still in the song and their licences, the attributions, and the ledger's
// hash — so a timestamp also proves how much of the work is human.
import type { Project } from '../types';
import { attributions, shares } from '../ensemble/ledger';
import { canonicalManifest, sha256Hex, type Contributions, type Manifest } from './manifest';

/** The ledger in the manifest: the human / AI share per track, the engines and their licences. */
export async function contributionsOf(p: Project): Promise<Contributions> {
  const tracks = shares(p).filter((t) => t.bars > 0);
  const bars = tracks.reduce((n, t) => n + t.bars, 0);
  const ai = tracks.reduce((n, t) => n + t.bars * t.ai, 0);
  const ledger = p.ledger ?? [];
  // Only engines whose part is still in the song (an entry whose regions were all deleted no longer counts).
  const alive = new Set(p.regions.map((r) => r.contribution).filter(Boolean));
  const byEngine = new Map<string, Contributions['engines'][number]>();
  for (const e of ledger.filter((x) => alive.has(x.id))) {
    const have = byEngine.get(e.engine);
    const license = [e.license.code, e.license.weights && e.license.weights !== e.license.code ? `weights ${e.license.weights}` : ''].filter(Boolean).join(', ');
    if (have) {
      if (!have.capabilities.includes(e.capability)) have.capabilities.push(e.capability);
    } else byEngine.set(e.engine, { id: e.engine, name: e.engineName ?? e.engine, ...(e.engineVersion ? { version: e.engineVersion } : {}), capabilities: [e.capability], license, commercial: e.license.commercial });
  }
  return {
    ai_share: bars ? +(ai / bars).toFixed(3) : 0,
    tracks: tracks.map((t) => ({ name: t.name, bars: t.bars, ai_share: t.ai, engines: t.engines })),
    engines: [...byEngine.values()].map((e) => ({ ...e, capabilities: e.capabilities.sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    attributions: attributions(p),
    ledger_sha256: await sha256Hex(canonicalManifest(ledger as unknown as Manifest)),
    ledger_entries: ledger.length,
  };
}
