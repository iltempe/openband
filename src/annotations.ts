// Annotations ("Explain" mode, F14). Pure: target checks, orphans, anchors, threads.
import type { Annotation, AnnotationTarget, Project } from './types';

export const MAX_ANNOTATION = 500;
const TYPES = ['project', 'track', 'region', 'notes', 'section', 'range'] as const;

/** Validate a target given by the AI or the UI (ids must exist when it's created). */
export function checkTarget(p: Project, t: Partial<AnnotationTarget> | undefined): AnnotationTarget {
  const type = t?.type ?? 'project';
  if (!TYPES.includes(type)) throw new Error(`target.type must be one of ${TYPES.join(', ')}`);
  const out: AnnotationTarget = { type };
  if (type === 'track' || type === 'region' || type === 'section') {
    if (!t?.id) throw new Error(`target.id is required for a ${type}`);
    out.id = t.id;
  }
  if (type === 'notes') {
    if (!t?.note_ids?.length) throw new Error('target.note_ids is required for notes');
    out.note_ids = [...new Set(t.note_ids)];
    const region = t.id ? p.regions.find((r) => r.id === t.id) : p.regions.find((r) => r.notes.some((n) => out.note_ids!.includes(n.id)));
    if (region) out.id = region.id;
  }
  if (type === 'range') {
    const a = Number(t?.from_beat);
    const b = Number(t?.to_beat);
    if (!(Number.isFinite(a) && Number.isFinite(b) && b > a && a >= 0)) throw new Error('A range needs 0 ≤ from_beat < to_beat');
    out.from_beat = a;
    out.to_beat = b;
  }
  if (!targetExists(p, out)) throw new Error(`The ${type} "${out.id ?? out.note_ids?.join(',')}" doesn't exist`);
  return out;
}

export function targetExists(p: Project, t: AnnotationTarget): boolean {
  switch (t.type) {
    case 'project':
    case 'range':
      return true;
    case 'track':
      return p.tracks.some((x) => x.id === t.id);
    case 'region':
      return p.regions.some((x) => x.id === t.id);
    case 'section':
      return (p.sections ?? []).some((x) => x.id === t.id);
    case 'notes': {
      const ids = new Set(t.note_ids);
      return p.regions.some((r) => r.notes.some((n) => ids.has(n.id)));
    }
  }
}

/** Mark annotations whose target was deleted as orphaned (and un-mark them if it came back). In place. */
export function reconcileAnnotations(p: Project): void {
  for (const a of p.annotations ?? []) {
    const orphan = !targetExists(p, a.target);
    if (orphan) a.orphaned = true;
    else if (a.orphaned) delete a.orphaned;
  }
}

/** Where a pin goes on the timeline, in beats (null for the whole project or a track). */
export function anchorBeat(p: Project, t: AnnotationTarget): number | null {
  switch (t.type) {
    case 'region':
      return p.regions.find((r) => r.id === t.id)?.start ?? null;
    case 'section':
      return p.sections?.find((s) => s.id === t.id)?.start ?? null;
    case 'range':
      return t.from_beat ?? null;
    case 'notes': {
      const ids = new Set(t.note_ids);
      for (const r of p.regions) {
        const ns = r.notes.filter((n) => ids.has(n.id));
        if (ns.length) return r.start + Math.min(...ns.map((n) => n.start));
      }
      return null;
    }
    default:
      return null;
  }
}

/** Same target → same thread. */
export const threadKey = (t: AnnotationTarget) =>
  t.type === 'notes' ? `notes:${[...(t.note_ids ?? [])].sort().join(',')}` : t.type === 'range' ? `range:${t.from_beat}-${t.to_beat}` : `${t.type}:${t.id ?? ''}`;

/** Does an annotation's target match a filter (same type and id; notes overlap; ranges overlap)? */
export function matchesTarget(a: AnnotationTarget, f: Partial<AnnotationTarget>): boolean {
  if (f.type && f.type !== a.type) {
    // A region filter also finds the notes inside it.
    if (!(f.type === 'region' && a.type === 'notes' && a.id === f.id)) return false;
    return true;
  }
  if (f.id && a.id !== f.id) return false;
  if (f.note_ids?.length && !a.note_ids?.some((n) => f.note_ids!.includes(n))) return false;
  if (f.from_beat !== undefined && f.to_beat !== undefined && a.type === 'range' && !(a.from_beat! < f.to_beat && a.to_beat! > f.from_beat)) return false;
  return true;
}

export interface Thread {
  key: string;
  target: AnnotationTarget;
  items: Annotation[];
  resolved: boolean;
  orphaned: boolean;
}

/** Group annotations into threads, oldest first inside a thread, newest thread first. */
export function threads(list: Annotation[]): Thread[] {
  const map = new Map<string, Thread>();
  for (const a of [...list].sort((x, y) => x.createdAt - y.createdAt)) {
    const k = threadKey(a.target);
    const th = map.get(k) ?? { key: k, target: a.target, items: [], resolved: true, orphaned: false };
    th.items.push(a);
    th.resolved &&= !!a.resolved;
    th.orphaned ||= !!a.orphaned;
    map.set(k, th);
  }
  return [...map.values()].sort((a, b) => b.items[b.items.length - 1].createdAt - a.items[a.items.length - 1].createdAt);
}
