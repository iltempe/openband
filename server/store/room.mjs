// A room's song on disk (R1.5): during a session the room is the source of truth, so the store follows it.
// readRoomProject is src/collab/binding.ts readProject for the server; store.test.ts checks them against each other.
import * as Y from 'yjs';

const entries = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, v]));
const byStartPitch = (a, b) => a.start - b.start || a.pitch - b.pitch || (a.id < b.id ? -1 : 1);

export function readRoomProject(doc) {
  const project = doc.getMap('project');
  if (!project.size) return null;
  const tracks = doc.getMap('tracks');
  const regions = doc.getMap('regions');
  const p = JSON.parse(JSON.stringify(project.toJSON()));
  const order = [...new Set([...doc.getArray('trackOrder').toArray().filter((id) => tracks.has(id)), ...tracks.keys()])];
  p.tracks = order.map((id) => JSON.parse(JSON.stringify(entries(tracks.get(id)))));
  p.regions = [...regions.values()].map((m) => {
    const { notes, ...rest } = entries(m);
    return { ...JSON.parse(JSON.stringify(rest)), notes: notes instanceof Y.Map ? [...notes.values()].map((n) => JSON.parse(JSON.stringify(n))).sort(byStartPitch) : [] };
  });
  p.regions.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const list = (name) => [...doc.getMap(name).values()].map((v) => JSON.parse(JSON.stringify(v)));
  const sections = list('sections').sort((a, b) => a.start - b.start);
  if (sections.length) p.sections = sections;
  const annotations = list('annotations').sort((a, b) => a.createdAt - b.createdAt);
  if (annotations.length) p.annotations = annotations;
  const instruments = list('instruments');
  if (instruments.length) p.instruments = instruments;
  return p;
}

/** Versions and branch heads go to the store as they appear; the song itself when the room goes quiet. */
export function persistRoom(doc, store, { emit = () => {}, song = false, by = 'room' } = {}) {
  for (const v of doc.getMap('versions').values()) {
    try {
      store.putVersion(v.projectId, { ...v, snapshot: new Uint8Array(v.snapshot) });
    } catch {
      // a version that doesn't fit stays in the room
    }
  }
  for (const b of doc.getMap('branches').values()) store.putBranch(b.projectId, { id: `${b.projectId}:${b.name}`, projectId: b.projectId, name: b.name, headId: b.headId, at: b.at });
  if (!song) return null;
  const p = readRoomProject(doc);
  const id = p?.meta?.projectId;
  if (!id) return null;
  const { etag } = store.putProject(id, p, store.getProject(id)?.etag);
  emit({ kind: 'project_changed', id, etag, by });
  return id;
}
