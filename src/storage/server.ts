// A server's library as a backend (R1.5): this browser stays the working copy. Every write lands in the
// cache first and goes to the server afterwards; what cannot go now waits in an outbox and leaves when the
// network is back. Only songs that live on the server (they have an etag here) are sent at all.
import type { Project } from '../types';
import { canonicalJSON } from '../versions/canonical';
import { projectSampleIdsOf } from './samplesOf';
import { ConflictError } from './conflict';
import type { Backend, BackendStatus, BranchRef, ProjectStore, ProjectSummary, SampleStore, Stored, StoredVersion, VersionStore } from './types';
import type { JournalEntry, JournalStore } from '../journal/timeline';

export const PREFIX = '/api/store/v1';

export interface Kv {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface ServerOptions {
  url: string;
  cache: Backend;
  token?: string;
  /** OPENBAND_STORE_TOKEN of a public server. */
  instanceToken?: string;
  /** Names this device in events and conflict branches. */
  client?: string;
  fetch?: typeof fetch;
  kv: Kv;
  /** A write found the server had moved on. The song is safe in `mine`. */
  onConflict?: (mine: Project, serverEtag: string) => void;
  /** The key for what is remembered here: the desktop's own store changes port at every start. */
  scope?: string;
  /** This server is the browser's own library: every song lives there. */
  own?: boolean;
  /** Songs not worth a place in the library yet (empty, or the untouched demo). */
  keepOut?: (p: Project) => boolean;
  /** Pushing is paused meanwhile (in a room, the room is the source of truth). */
  paused?: () => boolean;
  onStatus?: (s: BackendStatus) => void;
}

interface Outbox {
  versions: { projectId: string; id: string }[];
  branches: string[];
  /** Songs with changes the server has not had yet (the bytes are in the cache). */
  projects: string[];
}

class Offline extends Error {}

const toBase64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const idOf = (p: Project) => p.meta?.projectId ?? 'local';

export class ServerBackend implements Backend {
  readonly kind = 'server';
  readonly url: string;
  private etags: Record<string, string>;
  private outbox: Outbox;
  private list: ProjectSummary[];
  private online = true;
  private conflicted = false;
  private sent = new Set<string>();
  private flushing: Promise<void> | null = null;
  private latest = new Map<string, Project>();
  /** The song as the server has it: a save that changes nothing is not sent (a song just loaded saves itself). */
  private known = new Map<string, string>();
  private fetcher: typeof fetch;
  private adopting = new Set<string>();

  constructor(private o: ServerOptions) {
    this.url = o.url.replace(/\/+$/, '');
    this.fetcher = o.fetch ?? ((...a) => fetch(...a));
    this.etags = this.read('etags', {});
    this.outbox = this.read('outbox', { versions: [], branches: [], projects: [] });
    this.list = this.read('list', []);
  }

  private key = (k: string) => `openband.store.${k}.${this.o.scope ?? this.url}`;
  private read<T>(k: string, fallback: T): T {
    try {
      return JSON.parse(this.o.kv.get(this.key(k)) ?? 'null') ?? fallback;
    } catch {
      return fallback;
    }
  }
  private save() {
    this.o.kv.set(this.key('etags'), JSON.stringify(this.etags));
    this.o.kv.set(this.key('outbox'), JSON.stringify(this.outbox));
    this.o.kv.set(this.key('list'), JSON.stringify(this.list));
    this.o.onStatus?.(this.status());
  }

  /** Lives on this server? */
  tracked = (id: string) => id in this.etags;
  pending = () => this.outbox.projects.length + this.outbox.versions.length + this.outbox.branches.length;

  status(): BackendStatus {
    return { kind: 'server', state: this.conflicted ? 'conflict' : !this.online ? 'offline' : this.pending() ? 'pending' : 'ready' };
  }

  headers(extra: Record<string, string> = {}) {
    return {
      ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}),
      ...(this.o.instanceToken ? { 'x-store-token': this.o.instanceToken } : {}),
      ...(this.o.client ? { 'x-openband-client': this.o.client } : {}),
      ...extra,
    };
  }

  async req(path: string, init: RequestInit = {}) {
    let r: Response;
    try {
      r = await this.fetcher(`${this.url}${PREFIX}${path}`, { ...init, headers: this.headers(init.headers as Record<string, string>) });
    } catch {
      this.online = false;
      throw new Offline('The server is not reachable');
    }
    this.online = true;
    return r;
  }

  private async ok(r: Response) {
    if (r.ok) return r;
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(r.status === 507 ? 'The library on the server is full' : (body.error ?? `Server error ${r.status}`));
  }

  readonly projects: ProjectStore = {
    list: async () => {
      try {
        this.list = (await (await this.ok(await this.req('/projects'))).json()) as ProjectSummary[];
        this.save();
      } catch (e) {
        if (!(e instanceof Offline)) throw e;
      }
      return this.list;
    },
    get: async (id): Promise<Stored<Project> | null> => {
      try {
        const r = await this.req(`/projects/${encodeURIComponent(id)}`);
        if (r.status === 404) return null;
        await this.ok(r);
        const etag = (r.headers.get('etag') ?? '').replace(/"/g, '');
        this.etags[id] = etag;
        this.save();
        const value = (await r.json()) as Project;
        this.known.set(id, canonicalJSON(value));
        return { value, etag };
      } catch (e) {
        if (e instanceof Offline) return this.o.cache.projects.get(id);
        throw e;
      }
    },
    put: async (p, ifMatch) => {
      const id = idOf(p);
      await this.o.cache.projects.put(p);
      if (!this.tracked(id) && this.o.own && !this.o.keepOut?.(p) && !this.adopting.has(id)) await this.adopt(p);
      if (!this.tracked(id)) return { etag: '' };
      if (this.known.get(id) === canonicalJSON(p)) return { etag: this.etags[id] };
      this.latest.set(id, p);
      if (!this.outbox.projects.includes(id)) this.outbox.projects.push(id);
      this.save();
      if (ifMatch !== undefined && ifMatch !== this.etags[id]) throw new ConflictError(this.etags[id]);
      await this.flush();
      return { etag: this.etags[id] };
    },
    trash: async (id) => {
      await this.ok(await this.req(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }));
      delete this.etags[id];
      this.save();
    },
  };

  readonly versions: VersionStore = {
    list: (projectId) => this.o.cache.versions.list(projectId),
    get: (id) => this.o.cache.versions.get(id),
    branches: (projectId) => this.o.cache.versions.branches(projectId),
    branch: (id) => this.o.cache.versions.branch(id),
    put: async (v) => {
      await this.o.cache.versions.put(v);
      if (!this.tracked(v.projectId)) return;
      this.outbox.versions.push({ projectId: v.projectId, id: v.id });
      this.save();
      await this.flush();
    },
    putBranch: async (b) => {
      await this.o.cache.versions.putBranch(b);
      if (!this.tracked(b.projectId)) return;
      if (!this.outbox.branches.includes(b.id)) this.outbox.branches.push(b.id);
      this.save();
      await this.flush();
    },
  };

  readonly samples: SampleStore = {
    has: async (id) => (await this.o.cache.samples.has(id)) || (await this.req(`/samples/${id}`, { method: 'HEAD' }).then((r) => r.ok, () => false)),
    get: async (id) => {
      const local = await this.o.cache.samples.get(id);
      if (local) return local;
      const r = await this.req(`/samples/${id}`).catch(() => null);
      if (!r?.ok) return null;
      const s = { id, name: decodeURIComponent(r.headers.get('x-sample-name') ?? id), type: r.headers.get('content-type') ?? 'audio/wav', data: await r.arrayBuffer() };
      await this.o.cache.samples.put(id, s.data, s.name, s.type);
      return s;
    },
    put: (id, data, name, type) => this.o.cache.samples.put(id, data, name, type),
  };

  // The journal is this browser's safety net: it follows the song when it can, and is not queued (versions carry the history).
  readonly journal: JournalStore = {
    load: (projectId) => this.o.cache.journal.load(projectId),
    put: async (entries: JournalEntry[]) => {
      await this.o.cache.journal.put(entries);
      const id = entries[0]?.projectId;
      if (id && this.tracked(id) && !this.o.paused?.()) await this.req(`/projects/${encodeURIComponent(id)}/journal`, { method: 'POST', body: JSON.stringify({ entries }) }).catch(() => null);
    },
    remove: (ids) => this.o.cache.journal.remove(ids),
  };

  /** Upload what the server lacks: a HEAD first, as ensureSamples does locally. */
  private async pushSamples(p: Project) {
    for (const id of new Set(projectSampleIdsOf(p))) {
      if (this.sent.has(id)) continue;
      const head = await this.req(`/samples/${id}`, { method: 'HEAD' });
      if (!head.ok) {
        const s = await this.o.cache.samples.get(id);
        if (!s) continue; // not on this device: somebody else has it
        await this.ok(await this.req(`/samples/${id}`, { method: 'PUT', body: s.data, headers: { 'content-type': s.type, 'x-sample-name': encodeURIComponent(s.name) } }));
      }
      this.sent.add(id);
    }
  }

  private async pushProject(id: string) {
    const p = this.latest.get(id) ?? (await this.o.cache.projects.get(id))?.value;
    if (!p) return void (this.outbox.projects = this.outbox.projects.filter((x) => x !== id));
    await this.pushSamples(p);
    const etag = this.etags[id];
    const r = await this.req(`/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(p), headers: { 'content-type': 'application/json', ...(etag ? { 'if-match': `"${etag}"` } : {}) } });
    if (r.status === 409) {
      const { etag: theirs } = (await r.json()) as { etag: string };
      // Never overwrite: from here it is the conflict handler's song to keep.
      this.outbox.projects = this.outbox.projects.filter((x) => x !== id);
      this.latest.delete(id);
      this.conflicted = true;
      this.o.onConflict?.(p, theirs);
      return;
    }
    await this.ok(r);
    this.etags[id] = ((await r.json()) as { etag: string }).etag;
    this.known.set(id, canonicalJSON(p));
    // Something newer arrived meanwhile: it stays queued.
    if ((this.latest.get(id) ?? p) === p) {
      this.latest.delete(id);
      this.outbox.projects = this.outbox.projects.filter((x) => x !== id);
    }
  }

  private async drain() {
    while (this.outbox.projects.length) await this.pushProject(this.outbox.projects[0]);
    while (this.outbox.versions.length) {
      const { projectId, id } = this.outbox.versions[0];
      const v = await this.o.cache.versions.get(id);
      if (v) await this.ok(await this.req(`/projects/${encodeURIComponent(projectId)}/versions/${id}`, { method: 'PUT', body: JSON.stringify({ ...v, snapshot: toBase64(new Uint8Array(v.snapshot)) }) }));
      this.outbox.versions.shift();
    }
    while (this.outbox.branches.length) {
      const id = this.outbox.branches[0];
      const b = await this.o.cache.versions.branch(id);
      if (b) await this.ok(await this.req(`/projects/${encodeURIComponent(b.projectId)}/branches`, { method: 'PUT', body: JSON.stringify(b) }));
      this.outbox.branches.shift();
    }
  }

  /** Send what is waiting, one run at a time; a run that finds the network gone leaves the outbox as it is. */
  flush(): Promise<void> {
    if (this.o.paused?.()) return Promise.resolve();
    this.flushing ??= this.drain()
      .catch((e) => {
        if (!(e instanceof Offline)) console.warn('[openband] store:', (e as Error).message);
      })
      .finally(() => {
        this.flushing = null;
        this.save();
      });
    return this.flushing;
  }

  /** A conflict was dealt with: this is the server's song, now the working copy. */
  resolved(id: string, etag: string) {
    this.etags[id] = etag;
    this.conflicted = false;
    this.save();
  }

  /** Put a browser song on the server, with its history and samples. */
  async adopt(p: Project) {
    const id = idOf(p);
    if (this.adopting.has(id)) return;
    this.adopting.add(id);
    try {
      await this.pushSamples(p);
      const r = await this.req(`/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(p), headers: { 'content-type': 'application/json' } });
      // The server already has this song and this browser forgot: the two copies are a conflict like any other.
      if (r.status === 428 || r.status === 409) {
        const { etag } = (await r.json()) as { etag: string };
        this.etags[id] = etag;
        this.conflicted = true;
        this.o.onConflict?.(p, etag);
        return;
      }
      await this.ok(r);
      this.etags[id] = ((await r.json()) as { etag: string }).etag;
      this.known.set(id, canonicalJSON(p));
    } catch (e) {
      if (e instanceof Offline) return; // the next save tries again
      throw e;
    } finally {
      this.adopting.delete(id);
    }
    for (const v of await this.o.cache.versions.list(id)) this.outbox.versions.push({ projectId: id, id: v.id });
    for (const b of await this.o.cache.versions.branches(id)) this.outbox.branches.push(b.id);
    this.save();
    await this.flush();
  }

  /** Copy a server song's versions and branches into the cache. */
  async pull(id: string) {
    const metas = (await (await this.ok(await this.req(`/projects/${encodeURIComponent(id)}/versions`))).json()) as StoredVersion[];
    for (const m of metas) {
      if (await this.o.cache.versions.get(m.id)) continue;
      const v = (await (await this.ok(await this.req(`/projects/${encodeURIComponent(id)}/versions/${m.id}`))).json()) as Omit<StoredVersion, 'snapshot'> & { snapshot: string };
      await this.o.cache.versions.put({ ...v, snapshot: fromBase64(v.snapshot) });
    }
    for (const b of (await (await this.ok(await this.req(`/projects/${encodeURIComponent(id)}/branches`))).json()) as BranchRef[]) {
      const have = await this.o.cache.versions.branch(b.id);
      if (!have || (have.at ?? 0) <= (b.at ?? 0)) await this.o.cache.versions.putBranch(b);
    }
  }

  etagOf = (id: string) => this.etags[id];
  /** The room saved the song: what is open here is what the server has. */
  followed = (id: string, etag: string) => void ((this.etags[id] = etag), this.save());

  /** Stop following a song: it stays on the server, and this browser keeps its own copy. */
  forget(id: string) {
    delete this.etags[id];
    this.outbox.projects = this.outbox.projects.filter((x) => x !== id);
    this.outbox.versions = this.outbox.versions.filter((v) => v.projectId !== id);
    this.save();
  }

  async space() {
    return (await (await this.ok(await this.req('/status'))).json()) as { used: number; quota: number; projects: number };
  }
}
