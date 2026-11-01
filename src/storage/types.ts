// Where a song's data lives (R1). The app talks to these interfaces only: LocalBackend is this browser
// (localStorage + IndexedDB), MemoryBackend is for the tests, ServerBackend arrives with the project store.
import type { Project } from '../types';
import type { JournalStore } from '../journal/timeline';

export interface Stored<T> {
  value: T;
  etag: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  bpm: number;
  key: string;
  updatedAt: number;
  versions: number;
  sizeBytes: number;
  source: 'local' | 'server';
  box?: { sessions: number };
}

export interface VersionMeta {
  id: string;
  projectId: string;
  parentIds: string[];
  branch: string;
  label: string;
  createdAt: number;
  author: 'user' | 'ai';
}
export interface StoredVersion extends VersionMeta {
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

export interface StoredSample {
  id: string;
  name: string;
  type: string;
  data: ArrayBuffer;
}

export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<Stored<Project> | null>;
  /** With ifMatch, a stale etag is refused (the server answers 409), never overwritten. */
  put(p: Project, ifMatch?: string): Promise<{ etag: string }>;
  trash(id: string): Promise<void>;
}

export interface VersionStore {
  list(projectId: string): Promise<StoredVersion[]>;
  get(id: string): Promise<StoredVersion | null>;
  put(v: StoredVersion): Promise<void>;
  branches(projectId: string): Promise<BranchRef[]>;
  branch(id: string): Promise<BranchRef | null>;
  putBranch(b: BranchRef): Promise<void>;
}

export interface SampleStore {
  has(id: string): Promise<boolean>;
  get(id: string): Promise<StoredSample | null>;
  put(id: string, data: ArrayBuffer, name: string, type: string): Promise<void>;
}

export interface BackendStatus {
  kind: 'local' | 'server';
  state: 'ready' | 'pending' | 'offline' | 'conflict';
}

export interface Backend {
  kind: 'local' | 'server';
  projects: ProjectStore;
  versions: VersionStore;
  samples: SampleStore;
  journal: JournalStore;
  status(): BackendStatus;
}
