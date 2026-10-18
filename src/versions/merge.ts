// Three-way merge of two versions of a song at entity level (track field, region, section, project
// field). Only one side changed → take it; both changed the same thing → conflict. Pure.
import type { Project } from '../types';

export type MergeStrategy = 'ours' | 'theirs' | 'manual';
export type EntityKind = 'project' | 'track' | 'region' | 'section' | 'lyrics' | 'instrument' | 'annotation';
export interface Pick {
  entity: EntityKind;
  /** Entity id; for project fields the field name (e.g. "bpm"); "trk_x.volume" picks one track field. */
  id: string;
  /** a = ours (current), b = theirs (the branch being merged in). */
  from: 'a' | 'b';
}
export interface Conflict {
  entity: EntityKind;
  id: string;
  name?: string;
  field?: string;
  ours: unknown;
  theirs: unknown;
}
export interface MergeResult {
  project: Project;
  conflicts: Conflict[];
  /** Short list of what came from the other side. */
  taken: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const PROJECT_FIELDS = ['name', 'bpm', 'key', 'masterVolume', 'loop', 'metronome', 'reference'] as const;

type Side = 'a' | 'b' | 'conflict';
/** Who wins for one value. */
function resolve3(base: unknown, a: unknown, b: unknown): Side | 'same' {
  if (same(a, b)) return 'same';
  if (same(a, base)) return 'b';
  if (same(b, base)) return 'a';
  return 'conflict';
}

interface Ctx {
  strategy: MergeStrategy;
  picks: Pick[];
  conflicts: Conflict[];
  taken: string[];
}

function decide(ctx: Ctx, entity: EntityKind, id: string, ours: unknown, theirs: unknown, name?: string, field?: string): 'a' | 'b' {
  const pick = ctx.picks.find((p) => p.entity === entity && p.id === (field && entity === 'track' ? `${id}.${field}` : id)) ?? ctx.picks.find((p) => p.entity === entity && p.id === id);
  if (pick) return pick.from;
  if (ctx.strategy === 'theirs') return 'b';
  if (ctx.strategy === 'manual') ctx.conflicts.push({ entity, id, ...(name ? { name } : {}), ...(field ? { field } : {}), ours: ours ?? null, theirs: theirs ?? null });
  return 'a';
}

/** Merge a keyed list; `fieldLevel` lets two sides change different fields of the same item. */
function mergeList<T extends { id: string; name?: string }>(ctx: Ctx, entity: EntityKind, base: T[] = [], a: T[] = [], b: T[] = [], fieldLevel?: readonly (keyof T)[]): T[] {
  const mb = new Map(base.map((x) => [x.id, x]));
  const ma = new Map(a.map((x) => [x.id, x]));
  const mbb = new Map(b.map((x) => [x.id, x]));
  const ids = [...a.map((x) => x.id), ...b.filter((x) => !ma.has(x.id)).map((x) => x.id)];
  const out: T[] = [];
  for (const id of ids) {
    const o = mb.get(id);
    const x = ma.get(id);
    const y = mbb.get(id);
    const r = resolve3(o, x, y);
    let v: T | undefined;
    if (r === 'same' || r === 'a') v = x;
    else if (r === 'b') {
      v = y;
      ctx.taken.push(`${entity} ${y?.name ?? x?.name ?? id}${y ? '' : ' (deleted)'}`);
    } else if (fieldLevel && x && y && o) {
      // Both changed the item (and neither deleted it): merge field by field.
      const m = { ...x };
      for (const f of Object.keys({ ...x, ...y }) as (keyof T)[]) {
        const rf = resolve3(o[f], x[f], y[f]);
        if (rf === 'b') m[f] = y[f];
        else if (rf === 'conflict' && decide(ctx, entity, id, x[f], y[f], x.name, f as string) === 'b') m[f] = y[f];
      }
      v = m;
    } else {
      v = decide(ctx, entity, id, x, y, (x ?? y)?.name) === 'b' ? y : x;
    }
    if (v) out.push(v);
  }
  return out;
}

export function mergeProjects(base: Project, ours: Project, theirs: Project, strategy: MergeStrategy = 'manual', picks: Pick[] = []): MergeResult {
  const ctx: Ctx = { strategy, picks, conflicts: [], taken: [] };
  const out = structuredClone(ours);
  for (const f of PROJECT_FIELDS) {
    const r = resolve3(base[f], ours[f], theirs[f]);
    const val = r === 'b' || (r === 'conflict' && decide(ctx, 'project', f, ours[f], theirs[f], f) === 'b') ? theirs[f] : ours[f];
    if (r === 'b') ctx.taken.push(`${f} ${JSON.stringify(theirs[f])}`);
    (out as unknown as Record<string, unknown>)[f] = structuredClone(val);
    if (val === undefined) delete (out as unknown as Record<string, unknown>)[f];
  }
  out.tracks = structuredClone(mergeList(ctx, 'track', base.tracks, ours.tracks, theirs.tracks, ['name', 'instrument', 'volume', 'pan', 'mute', 'solo', 'reverb', 'delay', 'cutoff', 'fx', 'automation', 'color', 'kind']));
  out.regions = structuredClone(mergeList(ctx, 'region', base.regions, ours.regions, theirs.regions));
  out.sections = structuredClone(mergeList(ctx, 'section', base.sections, ours.sections, theirs.sections));
  if (!out.sections.length && !ours.sections && !theirs.sections) delete out.sections;
  out.instruments = structuredClone(mergeList(ctx, 'instrument', base.instruments, ours.instruments, theirs.instruments));
  if (!out.instruments.length && !ours.instruments && !theirs.instruments) delete out.instruments;
  out.annotations = structuredClone(mergeList(ctx, 'annotation', base.annotations, ours.annotations, theirs.annotations));
  if (!out.annotations.length && !ours.annotations && !theirs.annotations) delete out.annotations;
  const rl = resolve3(base.lyrics, ours.lyrics, theirs.lyrics);
  if (rl === 'b' || (rl === 'conflict' && decide(ctx, 'lyrics', 'lyrics', ours.lyrics, theirs.lyrics) === 'b')) {
    out.lyrics = structuredClone(theirs.lyrics);
    if (!out.lyrics) delete out.lyrics;
    if (rl === 'b') ctx.taken.push('lyrics');
  }
  // Regions whose track no longer exists can't stay.
  const trackIds = new Set(out.tracks.map((t) => t.id));
  out.regions = out.regions.filter((r) => trackIds.has(r.trackId));
  return { project: out, conflicts: ctx.conflicts, taken: ctx.taken };
}

/** Nearest common ancestor of two versions in a DAG given as id → parent ids. */
export function commonAncestor(parents: Map<string, string[]>, a: string, b: string): string | null {
  const seen = new Set<string>();
  const queue = [a];
  while (queue.length) {
    const x = queue.shift()!;
    if (seen.has(x)) continue;
    seen.add(x);
    queue.push(...(parents.get(x) ?? []));
  }
  const q2 = [b];
  const seen2 = new Set<string>();
  while (q2.length) {
    const x = q2.shift()!;
    if (seen.has(x)) return x;
    if (seen2.has(x)) continue;
    seen2.add(x);
    q2.push(...(parents.get(x) ?? []));
  }
  return null;
}
