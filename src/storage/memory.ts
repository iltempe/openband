// A backend in memory, for the tests. Same rules as the server: a stale etag is refused.
import type { Project } from '../types';
import { MemoryJournalStore } from '../journal/timeline';
import { ConflictError } from './conflict';
import { summaryOf } from './local';
import type { Backend, BranchRef, StoredSample, StoredVersion } from './types';

export { ConflictError };

export function MemoryBackend(): Backend & { trashed: Map<string, Project> } {
  const projects = new Map<string, { value: Project; etag: string }>();
  const trashed = new Map<string, Project>();
  const versions = new Map<string, StoredVersion>();
  const branches = new Map<string, BranchRef>();
  const samples = new Map<string, StoredSample>();
  let n = 0;
  const pidOf = (p: Project) => p.meta?.projectId ?? 'local';
  const countVersions = (id: string) => [...versions.values()].filter((v) => v.projectId === id).length;
  return {
    kind: 'local',
    trashed,
    journal: new MemoryJournalStore(),
    status: () => ({ kind: 'local', state: 'ready' }),
    projects: {
      async list() {
        return [...projects.values()].map(({ value }) => summaryOf(value, JSON.stringify(value).length, countVersions(pidOf(value)), 'local'));
      },
      async get(id) {
        const r = projects.get(id);
        return r ? structuredClone(r) : null;
      },
      async put(p, ifMatch) {
        const have = projects.get(pidOf(p));
        if (have && ifMatch !== undefined && ifMatch !== have.etag) throw new ConflictError(have.etag);
        const etag = `m${++n}`;
        projects.set(pidOf(p), { value: structuredClone(p), etag });
        return { etag };
      },
      async trash(id) {
        const r = projects.get(id);
        if (r) trashed.set(id, r.value);
        projects.delete(id);
      },
    },
    versions: {
      list: async (projectId) => [...versions.values()].filter((v) => v.projectId === projectId),
      get: async (id) => versions.get(id) ?? null,
      put: async (v) => void versions.set(v.id, v),
      branches: async (projectId) => [...branches.values()].filter((b) => b.projectId === projectId),
      branch: async (id) => branches.get(id) ?? null,
      putBranch: async (b) => void branches.set(b.id, b),
    },
    samples: {
      has: async (id) => samples.has(id),
      get: async (id) => samples.get(id) ?? null,
      put: async (id, data, name, type) => void samples.set(id, { id, data, name, type }),
    },
  };
}
