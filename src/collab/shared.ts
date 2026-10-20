// Versions shared in a room (F16 delta): every peer's saved versions and branch heads live in the Y.Doc,
// so the history of the song is the same for everyone. Pure Yjs, no store.
//   versions   Y.Map<versionId, SharedVersion>   (a gzipped snapshot of the project with its metadata)
//   branches   Y.Map<"projectId:name@client", {headId, at, by}>   one entry per peer and branch; readers take
//              the newest move (Yjs alone would settle two concurrent writes of one key by client order, not by time)
import * as Y from 'yjs';

export interface SharedVersion {
  id: string;
  projectId: string;
  parentIds: string[];
  branch: string;
  label: string;
  createdAt: number;
  author: 'user' | 'ai';
  /** Who saved it, in the room. */
  by?: string;
  /** gzip of the project JSON (the same bytes the local version store keeps). */
  snapshot: Uint8Array;
}

export interface SharedBranch {
  id: string;
  projectId: string;
  name: string;
  headId: string;
  /** When the head moved (the newest wins when two people move it at once). */
  at: number;
  by?: string;
}

export const versionsMap = (doc: Y.Doc) => doc.getMap<SharedVersion>('versions');
export const branchesMap = (doc: Y.Doc) => doc.getMap<SharedBranch>('branches');

/** Add versions the room doesn't have yet (a version never changes once saved). */
export function publishVersions(doc: Y.Doc, list: SharedVersion[], origin: unknown = 'versions') {
  const m = versionsMap(doc);
  const missing = list.filter((v) => !m.has(v.id));
  if (missing.length) doc.transact(() => missing.forEach((v) => m.set(v.id, v)), origin);
  return missing.length;
}

/** Move branch heads, unless someone moved them later. */
export function publishBranches(doc: Y.Doc, list: SharedBranch[], origin: unknown = 'versions') {
  const m = branchesMap(doc);
  const current = new Map(roomBranches(doc).map((b) => [b.id, b]));
  const newer = list.filter((b) => (current.get(b.id)?.at ?? -1) < b.at);
  if (newer.length) doc.transact(() => newer.forEach((b) => m.set(`${b.id}@${doc.clientID}`, b)), origin);
  return newer.length;
}

export const roomVersions = (doc: Y.Doc, projectId?: string) => [...versionsMap(doc).values()].filter((v) => !projectId || v.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

/** Branch heads: per branch, the newest move by anyone (ties: the larger head id, the same everywhere). */
export function roomBranches(doc: Y.Doc, projectId?: string): SharedBranch[] {
  const best = new Map<string, SharedBranch>();
  for (const b of branchesMap(doc).values()) {
    if (projectId && b.projectId !== projectId) continue;
    const cur = best.get(b.id);
    if (!cur || b.at > cur.at || (b.at === cur.at && b.headId > cur.headId)) best.set(b.id, b);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}
