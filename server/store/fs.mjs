// The project store on disk (R1.3): plain folders and gzip, so a backup is a copy of a folder (ADR 0005).
// Every write is atomic: a temporary file, fsync, rename. Node standard modules only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonicalJSON, projectSampleIds } from './canonical.mjs';

const TRASH_DAYS = 30;
const EXT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/webm': 'webm' };

export class StoreError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Ids come from URLs: one path segment, never a way out of the folder. */
export function safeId(id) {
  if (typeof id !== 'string' || !/^[\w][\w.:-]{0,127}$/.test(id) || id.includes('..')) throw new StoreError(400, 'Bad id');
  return id.replaceAll(':', '~');
}

export const defaultDataDir = (env = process.env) => env.OPENBAND_DATA || path.join(os.homedir(), '.openband', 'library');

export const etagOf = (project) => crypto.createHash('sha256').update(canonicalJSON(project)).digest('hex');

export class FsStore {
  /**
   * @param {{ dir?: string, quota?: number, now?: () => number, beforeRename?: (tmp: string, dest: string) => void }} [o]
   *   beforeRename is the tests' simulated crash.
   */
  constructor(o = {}) {
    this.dir = o.dir ?? defaultDataDir();
    this.now = o.now ?? (() => Date.now());
    this.beforeRename = o.beforeRename;
    for (const d of ['projects', 'samples', 'trash']) fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    this.sweepTemporary(this.dir);
    this.used = this.sizeOf(this.dir);
    this.quota = o.quota ?? envQuota(this.dir);
    this.purgeTrash();
  }

  sizeOf(p) {
    const s = fs.statSync(p);
    if (!s.isDirectory()) return s.size;
    return fs.readdirSync(p).reduce((sum, f) => sum + this.sizeOf(path.join(p, f)), 0);
  }

  /** What a crash left behind: a temporary file was never the real one. */
  sweepTemporary(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) this.sweepTemporary(f);
      else if (e.name.endsWith('.tmp')) fs.rmSync(f, { force: true });
    }
  }

  write(dest, data) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const before = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.beforeRename?.(tmp, dest);
    fs.renameSync(tmp, dest);
    syncDir(path.dirname(dest));
    this.used += data.length - before;
  }

  writeJson = (dest, v) => this.write(dest, Buffer.from(JSON.stringify(v)));
  readJson(file, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      throw e;
    }
  }

  projectDir = (id) => path.join(this.dir, 'projects', safeId(id));

  // ---- projects ----

  listProjects() {
    const out = [];
    for (const id of fs.readdirSync(path.join(this.dir, 'projects'))) {
      const dir = path.join(this.dir, 'projects', id);
      const p = this.readJson(path.join(dir, 'project.json'));
      if (!p) continue;
      const meta = this.readJson(path.join(dir, 'meta.json'), {});
      out.push({
        id: p.meta?.projectId ?? id,
        name: p.name,
        bpm: p.bpm,
        key: p.key,
        // When the song last changed, not when it arrived here: a first-run copy keeps its order.
        updatedAt: p.meta?.updatedAt ?? meta.updatedAt ?? 0,
        versions: this.versionMetas(id).length,
        sizeBytes: this.sizeOf(dir),
        source: 'server',
        ...(meta.box ? { box: meta.box } : {}),
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getProject(id) {
    const dir = this.projectDir(id);
    const value = this.readJson(path.join(dir, 'project.json'));
    return value ? { value, etag: this.readJson(path.join(dir, 'meta.json'), {}).etag ?? etagOf(value) } : null;
  }

  /** @throws StoreError 409 when ifMatch is stale, 428 when a project that exists is written without it. */
  putProject(id, project, ifMatch) {
    const dir = this.projectDir(id);
    if (project?.meta?.projectId !== id) throw new StoreError(400, 'meta.projectId must be the id in the path');
    const have = this.readJson(path.join(dir, 'meta.json'));
    if (have?.etag) {
      if (ifMatch === undefined) throw new StoreError(428, 'If-Match is required', { etag: have.etag });
      if (ifMatch !== have.etag) throw new StoreError(409, 'The project changed elsewhere', { etag: have.etag });
    }
    const etag = etagOf(project);
    const data = Buffer.from(JSON.stringify(project));
    this.ensureRoom(data.length);
    this.write(path.join(dir, 'project.json'), data);
    this.writeJson(path.join(dir, 'meta.json'), { ...have, etag, updatedAt: this.now() });
    return { etag };
  }

  /** What the Box knows about a song, shown in the list. */
  setBox(id, box) {
    const file = path.join(this.projectDir(id), 'meta.json');
    this.writeJson(file, { ...this.readJson(file, {}), box });
  }

  trashProject(id) {
    const dir = this.projectDir(id);
    if (!fs.existsSync(dir)) throw new StoreError(404, 'No such project');
    const meta = this.readJson(path.join(dir, 'meta.json'), {});
    this.writeJson(path.join(dir, 'meta.json'), { ...meta, trashedAt: this.now() });
    fs.renameSync(dir, path.join(this.dir, 'trash', `${safeId(id)}-${this.now()}`));
  }

  /** Empty what has been in the trash for 30 days, then the samples nothing refers to any more. */
  purgeTrash() {
    const limit = this.now() - TRASH_DAYS * 86400_000;
    let purged = 0;
    for (const name of fs.readdirSync(path.join(this.dir, 'trash'))) {
      const dir = path.join(this.dir, 'trash', name);
      const { trashedAt } = this.readJson(path.join(dir, 'meta.json'), {});
      if (trashedAt !== undefined && trashedAt > limit) continue;
      this.used -= this.sizeOf(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      purged++;
    }
    if (purged) this.collectSamples();
    return purged;
  }

  /** Reference counting across every project, its versions, and what is still in the trash. */
  collectSamples() {
    const keep = new Set();
    const scan = (dir) => {
      const p = this.readJson(path.join(dir, 'project.json'));
      if (p) projectSampleIds(p).forEach((s) => keep.add(s));
      const vdir = path.join(dir, 'versions');
      if (!fs.existsSync(vdir)) return;
      for (const f of fs.readdirSync(vdir)) if (f.endsWith('.json.gz')) projectSampleIds(JSON.parse(gunzipSync(fs.readFileSync(path.join(vdir, f))).toString())).forEach((s) => keep.add(s));
    };
    for (const root of ['projects', 'trash']) for (const d of fs.readdirSync(path.join(this.dir, root))) scan(path.join(this.dir, root, d));
    const sdir = path.join(this.dir, 'samples');
    for (const f of fs.readdirSync(sdir)) {
      const id = f.replace(/\.(meta\.json|[^.]+)$/, '');
      if (keep.has(id)) continue;
      this.used -= fs.statSync(path.join(sdir, f)).size;
      fs.rmSync(path.join(sdir, f));
    }
  }

  // ---- versions (append-only) and branches ----

  versionMetas(id) {
    const dir = path.join(this.projectDir(id), 'versions');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => this.readJson(path.join(dir, f)))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getVersion(id, vid) {
    const dir = path.join(this.projectDir(id), 'versions');
    const meta = this.readJson(path.join(dir, `${safeId(vid)}.meta.json`));
    return meta ? { ...meta, snapshot: fs.readFileSync(path.join(dir, `${safeId(vid)}.json.gz`)) } : null;
  }

  /** A version never changes: the same bytes again are fine, different ones are a conflict. */
  putVersion(id, version) {
    if (!(version.snapshot instanceof Uint8Array)) throw new StoreError(400, 'snapshot is required');
    if (version.projectId !== id) throw new StoreError(400, 'projectId must be the id in the path');
    const { snapshot, ...meta } = version;
    const dir = path.join(this.projectDir(id), 'versions');
    const file = path.join(dir, `${safeId(version.id)}.json.gz`);
    if (fs.existsSync(file)) {
      if (Buffer.compare(fs.readFileSync(file), Buffer.from(snapshot))) throw new StoreError(409, 'Versions are append-only');
      return;
    }
    this.ensureRoom(snapshot.length);
    this.write(file, Buffer.from(snapshot));
    this.writeJson(path.join(dir, `${safeId(version.id)}.meta.json`), meta);
  }

  branches = (id) => this.readJson(path.join(this.projectDir(id), 'branches.json'), []);

  /** The newest move of a head wins, as in a room. */
  putBranch(id, ref) {
    if (ref?.projectId !== id || typeof ref.name !== 'string' || typeof ref.headId !== 'string') throw new StoreError(400, 'Bad branch');
    const all = this.branches(id);
    const have = all.find((b) => b.id === ref.id);
    if (have && (have.at ?? 0) > (ref.at ?? 0)) return have;
    this.writeJson(path.join(this.projectDir(id), 'branches.json'), [...all.filter((b) => b.id !== ref.id), ref]);
    return ref;
  }

  // ---- journal ----

  journal(id) {
    const dir = path.join(this.projectDir(id), 'journal');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, f))).toString()))
      .sort((a, b) => a.seq - b.seq);
  }

  appendJournal(id, entries = [], remove = []) {
    const dir = path.join(this.projectDir(id), 'journal');
    for (const e of entries) {
      const data = gzipSync(JSON.stringify(e));
      this.ensureRoom(data.length);
      this.write(path.join(dir, `${Number(e.seq) | 0}-${safeId(e.id)}.json.gz`), data);
    }
    if (!remove.length || !fs.existsSync(dir)) return;
    const gone = new Set(remove.map(safeId));
    for (const f of fs.readdirSync(dir)) {
      if (!gone.has(f.replace(/^\d+-/, '').replace(/\.json\.gz$/, ''))) continue;
      this.used -= fs.statSync(path.join(dir, f)).size;
      fs.rmSync(path.join(dir, f));
    }
  }

  // ---- samples, shared between projects ----

  sampleMeta = (id) => this.readJson(path.join(this.dir, 'samples', `${safeId(id)}.meta.json`));

  sampleFile(id) {
    const meta = this.sampleMeta(id);
    return meta ? { ...meta, file: path.join(this.dir, 'samples', `${safeId(id)}.${meta.ext}`) } : null;
  }

  /** Samples are named by their content: one that exists is not written again. */
  putSample(id, data, name, type) {
    if (this.sampleMeta(id)) return;
    this.ensureRoom(data.length);
    const ext = EXT[type] ?? 'bin';
    this.write(path.join(this.dir, 'samples', `${safeId(id)}.${ext}`), data);
    this.writeJson(path.join(this.dir, 'samples', `${safeId(id)}.meta.json`), { id, name, type, ext, bytes: data.length });
  }

  // ---- quota ----

  ensureRoom(bytes) {
    if (this.used + bytes > this.quota) throw new StoreError(507, 'The library is full', { used: this.used, quota: this.quota });
  }

  status() {
    return { used: this.used, quota: this.quota, projects: fs.readdirSync(path.join(this.dir, 'projects')).length };
  }
}

function syncDir(dir) {
  // Windows refuses to open a folder; the rename is durable enough there.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** OPENBAND_STORE_QUOTA in bytes, or 80% of what is free on the disk at start. */
function envQuota(dir, env = process.env) {
  const n = Number(env.OPENBAND_STORE_QUOTA);
  if (n > 0) return n;
  try {
    const s = fs.statfsSync(dir);
    return Math.floor(Number(s.bavail) * Number(s.bsize) * 0.8);
  } catch {
    return Number.MAX_SAFE_INTEGER; // Node without statfs
  }
}
