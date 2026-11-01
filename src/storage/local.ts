// This browser as a backend: the song being worked on in localStorage (one slot, as always), versions,
// branches and samples in IndexedDB, the journal in journal/idb.ts.
import { gunzipSync, strFromU8 } from 'fflate';
import type { Project } from '../types';
import { migrate } from '../migrations';
import { idbJournal } from '../journal/idb';
import { tx } from './idb';
import type { Backend, BranchRef, ProjectStore, ProjectSummary, SampleStore, StoredSample, StoredVersion, VersionStore } from './types';

const STORAGE_KEY = 'openband.project.v2';
/** Autosave key used by OpenBand 0.1 (schema v1), still read as a fallback. */
const LEGACY_STORAGE_KEY = 'openband.project.v1';

/** The autosaved song. Synchronous: the store starts from it. */
export function readAutosave(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? migrate(raw) : null;
  } catch {
    return null;
  }
}

/** The newest saved state of every song with versions: how a song that isn't the working one stays in the browser. */
async function parked(): Promise<Map<string, StoredVersion>> {
  const newest = new Map<string, StoredVersion>();
  for (const v of (await tx<StoredVersion[]>('versions', 'readonly', (s) => s.getAll())) ?? []) {
    const have = newest.get(v.projectId);
    if (!have || have.createdAt <= v.createdAt) newest.set(v.projectId, v);
  }
  return newest;
}
const unpack = (v: StoredVersion) => migrate(strFromU8(gunzipSync(new Uint8Array(v.snapshot))));

const etagOf = (p: Project) => String(p.meta?.updatedAt ?? 0);

export const summaryOf = (p: Project, sizeBytes: number, versions: number, source: ProjectSummary['source']): ProjectSummary => ({
  id: p.meta?.projectId ?? 'local',
  name: p.name,
  bpm: p.bpm,
  key: p.key,
  updatedAt: p.meta?.updatedAt ?? 0,
  versions,
  sizeBytes,
  source,
});

export const localProjects: ProjectStore = {
  async list() {
    const p = readAutosave();
    const out: ProjectSummary[] = [];
    const id = p ? (p.meta?.projectId ?? 'local') : null;
    if (p) out.push(summaryOf(p, JSON.stringify(p).length, (await localVersions.list(id!).catch(() => [])).length, 'local'));
    for (const [pid, v] of await parked().catch(() => new Map<string, StoredVersion>())) {
      if (pid === id) continue;
      out.push({ ...summaryOf(unpack(v), v.snapshot.length, (await localVersions.list(pid)).length, 'local'), id: pid, updatedAt: v.createdAt });
    }
    return out;
  },
  async get(id) {
    const p = readAutosave();
    if (p && (p.meta?.projectId ?? 'local') === id) return { value: p, etag: etagOf(p) };
    const v = (await parked().catch(() => new Map<string, StoredVersion>())).get(id);
    return v ? { value: unpack(v), etag: String(v.createdAt) } : null;
  },
  async put(p) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable */
    }
    return { etag: etagOf(p) };
  },
  async trash(id) {
    const p = readAutosave();
    if (p && (p.meta?.projectId ?? 'local') === id) localStorage.removeItem(STORAGE_KEY);
  },
};

export const localVersions: VersionStore = {
  async list(projectId) {
    return ((await tx<StoredVersion[]>('versions', 'readonly', (s) => s.getAll())) ?? []).filter((v) => v.projectId === projectId);
  },
  async get(id) {
    return (await tx<StoredVersion | undefined>('versions', 'readonly', (s) => s.get(id))) ?? null;
  },
  async put(v) {
    await tx('versions', 'readwrite', (s) => s.put(v));
  },
  async branches(projectId) {
    return ((await tx<BranchRef[]>('branches', 'readonly', (s) => s.getAll())) ?? []).filter((b) => b.projectId === projectId);
  },
  async branch(id) {
    return (await tx<BranchRef | undefined>('branches', 'readonly', (s) => s.get(id))) ?? null;
  },
  async putBranch(b) {
    await tx('branches', 'readwrite', (s) => s.put(b));
  },
};

export const localSamples: SampleStore = {
  async has(id) {
    return (await tx<number>('samples', 'readonly', (s) => s.count(id))) > 0;
  },
  async get(id) {
    return (await tx<StoredSample | undefined>('samples', 'readonly', (s) => s.get(id))) ?? null;
  },
  async put(id, data, name, type) {
    await tx('samples', 'readwrite', (s) => s.put({ id, name, type, data } satisfies StoredSample));
  },
};

export const LocalBackend: Backend = {
  kind: 'local',
  projects: localProjects,
  versions: localVersions,
  samples: localSamples,
  journal: idbJournal,
  status: () => ({ kind: 'local', state: 'ready' }),
};
