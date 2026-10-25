// The release (SPEC v0.6 G6): what the song says about itself when it goes out — metadata, licence,
// credits, how AI was used — and what is in it: every piece of material with its licence, so a Creative
// Commons licence is checked against the samples, loops and engine parts it contains. Pure.
import type { Project, ReleaseMeta } from '../types';
import { shares } from '../ensemble/ledger';
import { LICENSES, materialAllows, type LicenseCode } from './license';

/** The release with its defaults filled in (title from the song, today, all rights reserved). */
export function releaseOf(p: Project): Required<Pick<ReleaseMeta, 'title' | 'license' | 'date' | 'aiDisclosure'>> & ReleaseMeta {
  const r = p.release ?? {};
  return {
    ...r,
    title: r.title || p.name,
    license: r.license || 'all-rights-reserved',
    date: r.date || new Date().toISOString().slice(0, 10),
    aiDisclosure: r.aiDisclosure || aiDisclosure(p),
  };
}

/** How AI was used, in words, from the ledger: which tracks engines made and how much of them. */
export function aiDisclosure(p: Project): string {
  const made = shares(p).filter((s) => s.bars > 0 && s.ai > 0);
  if (!made.length) return 'No AI-generated material.';
  const total = shares(p).reduce((n, s) => n + s.bars, 0);
  const ai = made.reduce((n, s) => n + s.bars * s.ai, 0);
  const parts = made.map((s) => `${s.name} (${Math.round(s.ai * 100)} %, ${s.engines.join(', ')})`);
  return `AI-assisted: ${Math.round((ai / Math.max(1, total)) * 100)} % of the music was made by engines — ${parts.join('; ')}. Everything else was written, played or chosen by the artist.`;
}

export interface Material {
  kind: 'sample' | 'loop' | 'engine' | 'recording';
  name: string;
  license: string;
  /** Where it is: track and region ids. */
  trackId: string;
  regionId: string;
  sampleId?: string;
}

/**
 * Everything in the song that came from somewhere: engine parts (their licence from the ledger), CC0
 * library loops, recordings (the artist's own), imported samples (the licence the user declared, or
 * unknown). loopIds: the CC0 library's ids; sampleNames: id → name.
 */
export function materials(p: Project, o: { loopIds?: Set<string>; sampleNames?: Record<string, string> } = {}): Material[] {
  const out: Material[] = [];
  const ledger = p.ledger ?? [];
  for (const r of p.regions) {
    const e = ledger.find((x) => x.regionIds?.includes(r.id) || x.id === r.contribution);
    if (e) {
      out.push({ kind: 'engine', name: e.engineName ?? e.engine, license: e.license.weights ?? e.license.code, trackId: r.trackId, regionId: r.id });
      continue;
    }
    if (!r.audio) continue;
    const name = o.sampleNames?.[r.audio.sampleId] ?? r.audio.sampleId;
    const base = name.replace(/\.wav$/i, '');
    if (o.loopIds?.has(base)) out.push({ kind: 'loop', name: base, license: 'CC0-1.0', trackId: r.trackId, regionId: r.id, sampleId: r.audio.sampleId });
    else if (/^Recording \d+|take \d+|\(punch\)|session comp/i.test(name)) out.push({ kind: 'recording', name, license: 'own', trackId: r.trackId, regionId: r.id, sampleId: r.audio.sampleId });
    else out.push({ kind: 'sample', name, license: p.sampleLicenses?.[r.audio.sampleId] ?? 'unknown', trackId: r.trackId, regionId: r.id, sampleId: r.audio.sampleId });
  }
  // One row per piece (a loop repeated in eight regions is one loop).
  return out.filter((m, i) => out.findIndex((x) => x.kind === m.kind && x.name === m.name && x.license === m.license) === i);
}

/** What in the song the chosen licence doesn't allow (empty: it's fine). */
export function licenseConflicts(p: Project, code: LicenseCode, o: Parameters<typeof materials>[1] = {}): (Material & { why: string })[] {
  if (!LICENSES[code]?.cc) return [];
  return materials(p, o)
    .filter((m) => m.license !== 'own')
    .map((m) => ({ ...m, why: materialAllows(m.license, code) ?? '' }))
    .filter((m) => m.why);
}
