// The CC0 loop library (F24): a manifest (public/loops/index.json) and search over it. Pure.
export interface LoopEntry {
  id: string;
  name: string;
  bpm: number;
  /** Musical key, when the loop has one ("Am", "C"). */
  key?: string;
  bars: number;
  tags: string[];
  /** Always CC0: the manifest test refuses anything else. */
  license: 'CC0';
  author: string;
  /** Relative to the manifest, or an absolute https URL of a CC0 source. */
  url: string;
  /** Where it comes from (how it was made, or the page of the original). */
  source: string;
}

export interface LoopManifest {
  version: 1;
  loops: LoopEntry[];
}

/** Errors in a manifest (empty = valid). Every loop must be CC0 with author and source. */
export function validateManifest(m: unknown): string[] {
  const errs: string[] = [];
  const o = m as LoopManifest;
  if (!o || o.version !== 1 || !Array.isArray(o.loops)) return ['manifest: version 1 with a loops list'];
  const ids = new Set<string>();
  for (const [i, l] of o.loops.entries()) {
    const at = `loops[${i}] ${l?.id ?? ''}`;
    if (!l || typeof l.id !== 'string' || !/^[a-z0-9-]+$/.test(l.id)) errs.push(`${at}: id (lowercase, digits, dashes)`);
    if (ids.has(l.id)) errs.push(`${at}: duplicate id`);
    ids.add(l.id);
    if (l.license !== 'CC0') errs.push(`${at}: license must be CC0`);
    if (!l.author?.trim()) errs.push(`${at}: author missing`);
    if (!l.source?.trim()) errs.push(`${at}: source missing`);
    if (!(typeof l.bpm === 'number' && l.bpm >= 40 && l.bpm <= 240)) errs.push(`${at}: bpm 40–240`);
    if (!(Number.isInteger(l.bars) && l.bars >= 1)) errs.push(`${at}: bars`);
    if (!Array.isArray(l.tags) || !l.tags.length) errs.push(`${at}: tags`);
    if (!l.url || !(/^loops\/[\w.-]+\.(wav|ogg|mp3|flac)$/.test(l.url) || /^https:\/\//.test(l.url))) errs.push(`${at}: url (loops/<file> or https://)`);
  }
  return errs;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const SYN: Record<string, string> = { batteria: 'drums', percussioni: 'drums', basso: 'bass', tastiere: 'keys', piano: 'keys', pianoforte: 'keys', archi: 'strings', chitarra: 'guitar', lofi: 'lo-fi', hiphop: 'boom-bap', 'hip-hop': 'boom-bap' };

/**
 * Loops matching words (name and tags), sorted by how well they match and by tempo distance.
 * A bpm keeps those within 15%; a key prefers that key (and its relative).
 */
export function searchLoops(m: LoopManifest, q: { query?: string; bpm?: number; key?: string; limit?: number } = {}): (LoopEntry & { score: number })[] {
  const words = norm(q.query ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((w) => SYN[w] ?? w);
  return m.loops
    .map((l) => {
      const hay = norm(`${l.name} ${l.tags.join(' ')} ${l.key ?? ''}`);
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += l.tags.some((t) => norm(t) === w) ? 3 : 1;
      if (words.length && !score) return null;
      if (q.bpm) {
        const d = Math.abs(l.bpm - q.bpm) / q.bpm;
        if (d > 0.15) return null;
        score += 2 * (1 - d / 0.15);
      }
      if (q.key && l.key) score += l.key === q.key ? 2 : 0;
      return { ...l, score: +score.toFixed(2) };
    })
    .filter((x): x is LoopEntry & { score: number } => !!x)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, q.limit ?? 20);
}
