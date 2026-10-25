// Versions and branches of a song (F13): snapshots in IndexedDB, HEAD per project, checkout, diff,
// merge and the compare view. The diff/merge logic itself is pure, in src/versions/.
import { create } from 'zustand';
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import type { Project } from './types';
import { useStore } from './store';
import { uid } from './music';
import { db } from './audio/samples';
import { migrate } from './migrations';
import { canonicalJSON } from './versions/canonical';
import { diffProjects, type ProjectDiff } from './versions/diff';
import { commonAncestor, mergeProjects, type MergeStrategy, type Pick } from './versions/merge';

export interface VersionMeta {
  id: string;
  projectId: string;
  parentIds: string[];
  branch: string;
  label: string;
  createdAt: number;
  author: 'user' | 'ai';
}
interface StoredVersion extends VersionMeta {
  /** gzip of the project JSON. */
  snapshot: Uint8Array;
}
export interface BranchRef {
  id: string; // `${projectId}:${name}`
  projectId: string;
  name: string;
  headId: string;
  /** When the head last moved (shared rooms: the newest wins). */
  at?: number;
}

// ---- sharing with a room (F16): listeners hear about every version saved / branch moved here,
// and versions / branches from the room are stored locally.
type Shared = { version?: StoredVersion; branch?: BranchRef };
const shareListeners = new Set<(s: Shared) => void>();
export const onVersionShared = (fn: (s: Shared) => void) => (shareListeners.add(fn), () => void shareListeners.delete(fn));
const share = (s: Shared) => shareListeners.forEach((fn) => fn(s));

/** Everything stored for a song (to give to a room). */
export async function storedFor(projectId: string): Promise<{ versions: StoredVersion[]; branches: BranchRef[] }> {
  const versions = ((await tx<StoredVersion[]>('versions', 'readonly', (s) => s.getAll())) ?? []).filter((v) => v.projectId === projectId);
  const branches = ((await tx<BranchRef[]>('branches', 'readonly', (s) => s.getAll())) ?? []).filter((b) => b.projectId === projectId);
  return { versions, branches };
}

/** Versions and branch heads from a room: kept locally (versions never change; heads: the newest move wins). */
export async function receiveShared(versions: StoredVersion[], branches: BranchRef[]) {
  let changed = 0;
  for (const v of versions) {
    const have = await tx<StoredVersion | undefined>('versions', 'readonly', (s) => s.get(v.id));
    if (have) continue;
    await tx('versions', 'readwrite', (s) => s.put({ ...v, snapshot: new Uint8Array(v.snapshot) }));
    changed++;
  }
  for (const b of branches) {
    const have = await tx<BranchRef | undefined>('branches', 'readonly', (s) => s.get(b.id));
    if (have && (have.at ?? 0) >= (b.at ?? 0)) continue;
    await tx('branches', 'readwrite', (s) => s.put(b));
    changed++;
  }
  if (changed && vs().projectId) await loadVersions();
  return changed;
}

interface VersionsState {
  projectId: string | null;
  branch: string;
  headId: string | null;
  versions: VersionMeta[];
  branches: BranchRef[];
  /** Compare view: the other version, and the diff from it to the current state. */
  compare: { versionId: string; label: string; snapshot: Project; diff: ProjectDiff } | null;
}

export const useVersions = create<VersionsState>(() => ({ projectId: null, branch: 'main', headId: null, versions: [], branches: [], compare: null }));

const st = () => useStore.getState();
const vs = () => useVersions.getState();
const headKey = (projectId: string) => `openband.head.${projectId}`;

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// No timestamp in the gzip header: the same song always packs to the same bytes (shared versions compare equal).
const pack = (p: Project) => gzipSync(strToU8(JSON.stringify(p)), { mtime: 0 });
const unpack = (b: Uint8Array) => migrate(strFromU8(gunzipSync(b)));
const projectIdOf = (p: Project) => p.meta?.projectId ?? 'local';

/** Load the version list of the current song (called when the song changes). */
export async function loadVersions() {
  const pid = projectIdOf(st().project);
  const all = ((await tx<StoredVersion[]>('versions', 'readonly', (s) => s.getAll())) ?? []).filter((v) => v.projectId === pid);
  const branches = ((await tx<BranchRef[]>('branches', 'readonly', (s) => s.getAll())) ?? []).filter((b) => b.projectId === pid);
  let head: { branch: string; headId: string | null } = { branch: 'main', headId: branches.find((b) => b.name === 'main')?.headId ?? null };
  try {
    const saved = JSON.parse(localStorage.getItem(headKey(pid)) ?? 'null');
    if (saved?.branch) head = saved;
  } catch {
    // no saved HEAD
  }
  useVersions.setState({
    projectId: pid,
    versions: all.map(({ snapshot: _, ...m }) => m).sort((a, b) => a.createdAt - b.createdAt),
    branches: branches.sort((a, b) => a.name.localeCompare(b.name)),
    branch: head.branch,
    headId: head.headId,
    compare: null,
  });
}

function setHead(branch: string, headId: string | null) {
  useVersions.setState({ branch, headId });
  try {
    localStorage.setItem(headKey(vs().projectId!), JSON.stringify({ branch, headId }));
  } catch {
    // not persisted
  }
}

async function getSnapshot(id: string): Promise<Project> {
  const v = await tx<StoredVersion | undefined>('versions', 'readonly', (s) => s.get(id));
  if (!v) throw new Error(`Version "${id}" not found. Call list_versions.`);
  return unpack(v.snapshot);
}

async function ensureLoaded() {
  if (vs().projectId !== projectIdOf(st().project)) await loadVersions();
}

/** A version id, a branch name or "HEAD" → version id. */
function resolveRef(ref: string): string {
  const s = vs();
  if (ref === 'HEAD') {
    if (!s.headId) throw new Error('No version saved yet');
    return s.headId;
  }
  if (s.versions.some((v) => v.id === ref)) return ref;
  const b = s.branches.find((x) => x.name === ref);
  if (b) return b.headId;
  const byLabel = [...s.versions].reverse().find((v) => v.label === ref);
  if (byLabel) return byLabel.id;
  throw new Error(`"${ref}" is not a version id, branch or label. Call list_versions.`);
}

/** True when the song differs from the version HEAD points at. */
export async function isDirty(): Promise<boolean> {
  await ensureLoaded();
  const h = vs().headId;
  if (!h) return true;
  return canonicalJSON(await getSnapshot(h)) !== canonicalJSON(st().project);
}

export async function saveVersion(label: string, author: 'user' | 'ai', extra: { parentIds?: string[]; branch?: string; project?: Project } = {}) {
  await ensureLoaded();
  const s = vs();
  const branch = extra.branch ?? s.branch;
  const project = structuredClone(extra.project ?? st().project);
  const v: StoredVersion = {
    id: uid('ver'),
    projectId: s.projectId!,
    parentIds: extra.parentIds ?? (s.headId ? [s.headId] : []),
    branch,
    label: label || `Version ${s.versions.length + 1}`,
    createdAt: Date.now(),
    author,
    snapshot: pack(project),
  };
  await tx('versions', 'readwrite', (x) => x.put(v));
  const ref: BranchRef = { id: `${v.projectId}:${branch}`, projectId: v.projectId, name: branch, headId: v.id, at: Date.now() };
  await tx('branches', 'readwrite', (x) => x.put(ref));
  share({ version: v, branch: ref });
  await loadVersions();
  setHead(branch, v.id);
  const { snapshot: _, ...meta } = v;
  return meta;
}

export async function listVersions(branch?: string) {
  await ensureLoaded();
  const s = vs();
  return {
    branch: s.branch,
    head_id: s.headId,
    dirty: await isDirty(),
    branches: s.branches.map((b) => ({ name: b.name, head_id: b.headId })),
    versions: s.versions
      .filter((v) => !branch || v.branch === branch)
      .map((v) => ({ id: v.id, label: v.label, branch: v.branch, parent_ids: v.parentIds, author: v.author, created_at: v.createdAt, ...(v.id === s.headId ? { head: true } : {}) }))
      .reverse(),
  };
}

export async function createBranch(name: string, fromVersionId?: string) {
  await ensureLoaded();
  const clean = name.trim();
  if (!/^[\w.\- ]{1,40}$/.test(clean)) throw new Error('Branch names: letters, digits, spaces, . _ - (max 40)');
  if (vs().branches.some((b) => b.name === clean)) throw new Error(`Branch "${clean}" already exists`);
  // Branching needs a version to start from: save the current state if there is none.
  const from = fromVersionId ? resolveRef(fromVersionId) : vs().headId ?? (await saveVersion('Start', 'user')).id;
  const ref: BranchRef = { id: `${vs().projectId}:${clean}`, projectId: vs().projectId!, name: clean, headId: from, at: Date.now() };
  await tx('branches', 'readwrite', (x) => x.put(ref));
  share({ branch: ref });
  await loadVersions();
  return { branch: clean, head_id: from };
}

/**
 * A version saved by itself before a destructive operation (F21): "Before: <what>". The state is taken
 * now (synchronously); nothing is saved for an empty song or one that equals the current version.
 */
export function autoVersion(what: string, project: Project = st().project, author: 'user' | 'ai' = 'user'): Promise<string | null> {
  const snap = structuredClone(project);
  if (!snap.tracks.length) return Promise.resolve(null);
  const label = `Before: ${what}`.slice(0, 80);
  return (async () => {
    // Let the operation that asked for it finish (it may replace the song: new_project, import).
    await new Promise((r) => setTimeout(r, 0));
    if (projectIdOf(snap) !== projectIdOf(st().project)) return await saveVersionOf(snap, label, author);
    await ensureLoaded();
    const h = vs().headId;
    if (h && canonicalJSON(await getSnapshot(h)) === canonicalJSON(snap)) return null;
    return (await saveVersion(label, author, { project: snap })).id;
  })().catch(() => null);
}

/** Save a version of a song that is not the open one, on its current branch (its HEAD moves to it). */
async function saveVersionOf(p: Project, label: string, author: 'user' | 'ai'): Promise<string | null> {
  const pid = projectIdOf(p);
  let head: { branch: string; headId: string | null } = { branch: 'main', headId: null };
  try {
    head = JSON.parse(localStorage.getItem(headKey(pid)) ?? 'null') ?? head;
  } catch {
    // main
  }
  if (head.headId) {
    const prev = await tx<StoredVersion | undefined>('versions', 'readonly', (s) => s.get(head.headId!));
    if (prev && canonicalJSON(unpack(prev.snapshot)) === canonicalJSON(p)) return null;
  }
  const v: StoredVersion = { id: uid('ver'), projectId: pid, parentIds: head.headId ? [head.headId] : [], branch: head.branch, label, createdAt: Date.now(), author, snapshot: pack(p) };
  await tx('versions', 'readwrite', (x) => x.put(v));
  await tx('branches', 'readwrite', (x) => x.put({ id: `${pid}:${head.branch}`, projectId: pid, name: head.branch, headId: v.id } satisfies BranchRef));
  try {
    localStorage.setItem(headKey(pid), JSON.stringify({ branch: head.branch, headId: v.id }));
  } catch {
    // not kept
  }
  return v.id;
}

/** Replace the song with a snapshot as one undoable step. */
export function replaceProject(next: Project, label: string) {
  const keepId = st().project.meta?.projectId;
  st().commit((d) => {
    for (const k of Object.keys(d)) delete (d as unknown as Record<string, unknown>)[k];
    Object.assign(d, structuredClone(next));
    if (d.meta && keepId) d.meta.projectId = keepId;
  }, { label });
}

export async function checkout(ref: { branch?: string; version_id?: string }, author: 'user' | 'ai') {
  await ensureLoaded();
  if (!ref.branch && !ref.version_id) throw new Error('Give a branch or a version_id');
  const wip = await autoVersion(`checkout ${ref.branch ?? ref.version_id}`, st().project, author);
  const branch = ref.branch ? vs().branches.find((b) => b.name === ref.branch) : undefined;
  if (ref.branch && !branch) throw new Error(`Branch "${ref.branch}" not found`);
  const id = branch ? branch.headId : resolveRef(ref.version_id!);
  const meta = vs().versions.find((v) => v.id === id)!;
  replaceProject(await getSnapshot(id), `Checkout ${branch ? branch.name : meta.label}`);
  setHead(branch ? branch.name : meta.branch, id);
  useVersions.setState({ compare: null });
  return { branch: vs().branch, head_id: id, label: meta.label, ...(wip ? { saved_wip: wip } : {}) };
}

export async function diffVersions(a: string, b?: string) {
  await ensureLoaded();
  const pa = await getSnapshot(resolveRef(a));
  const pb = b ? await getSnapshot(resolveRef(b)) : st().project;
  return diffProjects(pa, pb);
}

export async function mergeBranch(fromBranch: string, strategy: MergeStrategy = 'manual', picks: Pick[] = [], author: 'user' | 'ai' = 'user') {
  await ensureLoaded();
  const s = vs();
  const from = s.branches.find((b) => b.name === fromBranch);
  if (!from) throw new Error(`Branch "${fromBranch}" not found`);
  if (fromBranch === s.branch) throw new Error('Cannot merge a branch into itself');
  if (!s.headId) throw new Error('Save a version on this branch first');
  await autoVersion(`merge ${fromBranch}`, st().project, author);
  // The automatic version (if any) is the new HEAD of this branch.
  const headId = vs().headId!;
  const parents = new Map(vs().versions.map((v) => [v.id, v.parentIds]));
  const baseId = commonAncestor(parents, headId, from.headId);
  const theirs = await getSnapshot(from.headId);
  const base = baseId ? await getSnapshot(baseId) : theirs;
  const res = mergeProjects(base, st().project, theirs, strategy, picks);
  replaceProject(res.project, `Merge ${fromBranch}`);
  let version: string | undefined;
  if (!res.conflicts.length) version = (await saveVersion(`Merge ${fromBranch} into ${s.branch}`, author, { parentIds: [headId, from.headId] })).id;
  return { merged: fromBranch, into: s.branch, base_id: baseId, taken_from_branch: res.taken, conflicts: res.conflicts, ...(version ? { version_id: version } : {}) };
}

/** Compare view: show what changed between a version and the current state. */
export async function startCompare(versionId: string) {
  const snapshot = await getSnapshot(versionId);
  const meta = vs().versions.find((v) => v.id === versionId)!;
  useVersions.setState({ compare: { versionId, label: meta.label, snapshot, diff: diffProjects(snapshot, st().project) } });
}
export const stopCompare = () => useVersions.setState({ compare: null });

export function initVersions() {
  void loadVersions().catch(() => {});
  useStore.subscribe((s, prev) => {
    if (projectIdOf(s.project) !== projectIdOf(prev.project)) void loadVersions().catch(() => {});
    // Keep the compare view up to date while editing.
    const c = vs().compare;
    if (c && s.project !== prev.project) useVersions.setState({ compare: { ...c, diff: diffProjects(c.snapshot, s.project) } });
  });
}
