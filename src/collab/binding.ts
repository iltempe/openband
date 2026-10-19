// The song as a Yjs document (F16). Entities are keyed by id so concurrent edits to different notes,
// regions, tracks or fields merge on their own. Only Yjs is imported: testable in Node.
//
//   (top-level types)
//     project   Y.Map   scalar fields (name, bpm, key, masterVolume, loop, metronome, lyrics, reference, lint, meta)
//     trackOrder Y.Array<string>
//     tracks    Y.Map<id, Y.Map<field, value>>
//     regions   Y.Map<id, Y.Map<field, value> + notes: Y.Map<noteId, Note>>
//     sections / annotations / instruments   Y.Map<id, value>
import * as Y from 'yjs';
import type { Note, Project, Region, Track } from '../types';

const PROJECT_FIELDS = ['version', 'name', 'bpm', 'key', 'masterVolume', 'loop', 'metronome', 'lyrics', 'reference', 'lint', 'meta'] as const;
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const plain = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function roots(doc: Y.Doc) {
  // Top-level types are identified by name: two peers starting at once never overwrite each other.
  return {
    project: doc.getMap<unknown>('project'),
    trackOrder: doc.getArray<string>('trackOrder'),
    tracks: doc.getMap<Y.Map<unknown>>('tracks'),
    regions: doc.getMap<Y.Map<unknown>>('regions'),
    sections: doc.getMap<unknown>('sections'),
    annotations: doc.getMap<unknown>('annotations'),
    instruments: doc.getMap<unknown>('instruments'),
  };
}

/** True when nobody has written a song into the doc yet. */
export const isEmptyDoc = (doc: Y.Doc) => roots(doc).project.size === 0;

/** Set the fields of a Y.Map that changed, delete the ones that are gone. */
function syncFields(m: Y.Map<unknown>, obj: Record<string, unknown>, skip: string[] = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (skip.includes(k) || v === undefined) continue;
    if (!same(m.get(k), v)) m.set(k, plain(v));
  }
  for (const k of [...m.keys()]) if (!skip.includes(k) && obj[k] === undefined) m.delete(k);
}

/** Keyed collection of plain values. */
function syncValues<T extends { id: string }>(m: Y.Map<unknown>, items: T[] = []) {
  const ids = new Set(items.map((x) => x.id));
  for (const k of [...m.keys()]) if (!ids.has(k)) m.delete(k);
  for (const x of items) if (!same(m.get(x.id), x)) m.set(x.id, plain(x));
}

function syncNotes(m: Y.Map<unknown>, notes: Note[]) {
  syncValues(m, notes);
}

/** Write the changes from the doc's current content to `p` (only what differs is touched). */
export function writeProject(doc: Y.Doc, p: Project, origin: unknown) {
  doc.transact(() => {
    const r = roots(doc);
    syncFields(r.project, Object.fromEntries(PROJECT_FIELDS.map((f) => [f, p[f]])));
    // Track order: replace only if it changed.
    const order = p.tracks.map((t) => t.id);
    if (!same(r.trackOrder.toArray(), order)) {
      r.trackOrder.delete(0, r.trackOrder.length);
      r.trackOrder.push(order);
    }
    const tids = new Set(order);
    for (const k of [...r.tracks.keys()]) if (!tids.has(k)) r.tracks.delete(k);
    for (const t of p.tracks) {
      let m = r.tracks.get(t.id);
      if (!m) {
        m = new Y.Map();
        r.tracks.set(t.id, m);
      }
      syncFields(m, t as unknown as Record<string, unknown>);
    }
    const rids = new Set(p.regions.map((x) => x.id));
    for (const k of [...r.regions.keys()]) if (!rids.has(k)) r.regions.delete(k);
    for (const reg of p.regions) {
      let m = r.regions.get(reg.id);
      if (!m) {
        m = new Y.Map();
        m.set('notes', new Y.Map());
        r.regions.set(reg.id, m);
      }
      syncFields(m, reg as unknown as Record<string, unknown>, ['notes']);
      let notes = m.get('notes') as Y.Map<unknown> | undefined;
      if (!(notes instanceof Y.Map)) {
        notes = new Y.Map();
        m.set('notes', notes);
      }
      syncNotes(notes, reg.notes);
    }
    syncValues(r.sections, p.sections);
    syncValues(r.annotations, p.annotations);
    syncValues(r.instruments, p.instruments);
  }, origin);
}

const byStartPitch = (a: Note, b: Note) => a.start - b.start || a.pitch - b.pitch || (a.id < b.id ? -1 : 1);

/** Read the song back from the doc. Lists keep a stable order (tracks by trackOrder). */
export function readProject(doc: Y.Doc, previous?: Project): Project {
  const r = roots(doc);
  const p = Object.fromEntries([...r.project.entries()].map(([k, v]) => [k, plain(v)])) as unknown as Project;
  const trackMaps = r.tracks;
  const order = [...new Set([...r.trackOrder.toArray().filter((id) => trackMaps.has(id)), ...trackMaps.keys()])];
  p.tracks = order.map((id) => Object.fromEntries([...trackMaps.get(id)!.entries()].map(([k, v]) => [k, plain(v)])) as unknown as Track);
  // Regions in the order the previous state had them (so React keys and lanes don't jump), new ones last.
  const prevOrder = new Map((previous?.regions ?? []).map((x, i) => [x.id, i]));
  p.regions = [...r.regions.entries()]
    .map(([, m]) => {
      const reg = Object.fromEntries([...m.entries()].filter(([k]) => k !== 'notes').map(([k, v]) => [k, plain(v)])) as unknown as Region;
      const notes = m.get('notes');
      reg.notes = notes instanceof Y.Map ? ([...notes.values()].map((n) => plain(n)) as Note[]).sort(byStartPitch) : [];
      return reg;
    })
    .sort((a, b) => (prevOrder.get(a.id) ?? 1e9) - (prevOrder.get(b.id) ?? 1e9) || a.start - b.start || (a.id < b.id ? -1 : 1));
  const list = <T,>(m: Y.Map<unknown>) => [...m.values()].map((v) => plain(v) as T);
  const sections = list<NonNullable<Project['sections']>[number]>(r.sections).sort((a, b) => a.start - b.start);
  if (sections.length || previous?.sections) p.sections = sections;
  const annotations = list<NonNullable<Project['annotations']>[number]>(r.annotations).sort((a, b) => a.createdAt - b.createdAt);
  if (annotations.length || previous?.annotations) p.annotations = annotations;
  const instruments = list<NonNullable<Project['instruments']>[number]>(r.instruments);
  if (instruments.length || previous?.instruments) p.instruments = instruments;
  return p;
}

/** Per-user undo: only changes made with `origin` are undone. */
export function undoManagerFor(doc: Y.Doc, origin: unknown, captureTimeout = 500) {
  const r = roots(doc);
  return new Y.UndoManager([r.project, r.trackOrder, r.tracks, r.regions, r.sections, r.annotations, r.instruments], { trackedOrigins: new Set([origin]), captureTimeout });
}
