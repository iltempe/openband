// Deterministic JSON for projects: sorted keys, numbers rounded to 4 decimals, unordered lists sorted.
// The same song always gives the same string, whatever order things were added in — so songs
// versioned with git get readable diffs.
import type { Project } from '../types';

const round = (x: number) => (Number.isInteger(x) ? x : Math.round(x * 1e4) / 1e4);

function normalize(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? round(v) : null;
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = normalize(x);
    }
    return out;
  }
  return v;
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
const byNote = (a: { start: number; pitch: number; id: string }, b: { start: number; pitch: number; id: string }) => cmp(round(a.start), round(b.start)) || a.pitch - b.pitch || cmp(a.id, b.id);

/**
 * Put the lists whose order carries no meaning in a fixed order. Track order is kept: it's the order
 * of the lanes on screen.
 */
export function canonicalProject(p: Project): Project {
  const c = structuredClone(p);
  c.regions = c.regions
    .map((r) => ({ ...r, notes: [...r.notes].sort(byNote), ...(r.takes ? { takes: r.takes.map((t) => ({ ...t, notes: [...t.notes].sort(byNote) })) } : {}) }))
    .sort((a, b) => cmp(a.trackId, b.trackId) || cmp(round(a.start), round(b.start)) || cmp(a.id, b.id));
  if (c.sections) c.sections = [...c.sections].sort((a, b) => a.start - b.start || cmp(a.id, b.id));
  if (c.instruments) c.instruments = [...c.instruments].sort((a, b) => cmp(a.id, b.id));
  if (c.annotations) c.annotations = [...c.annotations].sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id));
  for (const t of c.tracks) if (t.automation) for (const k of Object.keys(t.automation) as (keyof typeof t.automation)[]) t.automation[k] = [...t.automation[k]!].sort((a, b) => a.beat - b.beat);
  return c;
}

/** Canonical JSON string (2-space indented, one note per line is left to the JSON layout). */
export function canonicalJSON(p: Project, opts: { includeMeta?: boolean } = {}): string {
  const c = canonicalProject(p);
  // updatedAt changes on every save: leave it out so unchanged songs give identical files.
  if (c.meta && !opts.includeMeta) c.meta = { ...c.meta, updatedAt: 0 };
  return JSON.stringify(normalize(c), null, 2);
}
