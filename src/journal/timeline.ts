// The journal's model (F21): an append-only list of patches with periodic full checkpoints, per song.
// Any instant can be rebuilt (the last checkpoint at or before it, plus the patches after it). Storage is
// behind an interface: IndexedDB in the app (journal/idb.ts), memory in the tests.
import type { Project } from '../types';
import { apply, diff, type Op } from './patch';

export interface JournalEntry {
  id: string;
  projectId: string;
  seq: number;
  at: number;
  kind: 'entry' | 'checkpoint';
  label: string;
  source: 'ui' | 'ai' | 'system';
  /** entry: the patch from the previous state; checkpoint: the whole project. */
  patch?: Op[];
  project?: Project;
  /** Approximate stored size, bytes. */
  size: number;
}

export interface JournalStore {
  load(projectId: string): Promise<JournalEntry[]>;
  put(entries: JournalEntry[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

export class MemoryJournalStore implements JournalStore {
  rows = new Map<string, JournalEntry>();
  async load(projectId: string) {
    return [...this.rows.values()].filter((r) => r.projectId === projectId).sort((a, b) => a.seq - b.seq).map((r) => structuredClone(r));
  }
  async put(entries: JournalEntry[]) {
    for (const e of entries) this.rows.set(e.id, structuredClone(e));
  }
  async remove(ids: string[]) {
    for (const id of ids) this.rows.delete(id);
  }
}

export interface JournalOptions {
  checkpointEvery: number;
  checkpointMs: number;
  maxAgeMs: number;
  maxBytes: number;
}
export const DEFAULT_JOURNAL: JournalOptions = { checkpointEvery: 50, checkpointMs: 10 * 60 * 1000, maxAgeMs: 30 * 24 * 3600 * 1000, maxBytes: 200 * 1024 * 1024 };

const sizeOf = (v: unknown) => (JSON.stringify(v) ?? '').length;

/** The journal of one song, kept in memory once loaded (writes go through to the store). */
export class SongJournal {
  entries: JournalEntry[] = [];
  /** The state after the last entry. */
  head: Project | null = null;
  private sinceCheckpoint = 0;
  private lastCheckpointAt = 0;

  constructor(
    readonly projectId: string,
    private store: JournalStore,
    private opts: JournalOptions = DEFAULT_JOURNAL,
  ) {}

  async load() {
    this.entries = await this.store.load(this.projectId);
    this.head = this.entries.length ? this.stateAtIndex(this.entries.length - 1) : null;
    const lastCp = [...this.entries].reverse().find((e) => e.kind === 'checkpoint');
    this.lastCheckpointAt = lastCp?.at ?? 0;
    this.sinceCheckpoint = lastCp ? this.entries.length - 1 - this.entries.indexOf(lastCp) : this.entries.length;
    return this;
  }

  get lastAt() {
    return this.entries[this.entries.length - 1]?.at ?? 0;
  }

  private nextSeq() {
    return (this.entries[this.entries.length - 1]?.seq ?? 0) + 1;
  }

  /** Record a new state. Returns the entry (null when nothing changed). */
  async record(project: Project, label: string, source: JournalEntry['source'], at = Date.now()): Promise<JournalEntry | null> {
    const seq = this.nextSeq();
    const patch = this.head ? diff(this.head, project) : null;
    if (patch && !patch.length) return null;
    const due = !this.head || this.sinceCheckpoint >= this.opts.checkpointEvery || at - this.lastCheckpointAt >= this.opts.checkpointMs;
    let e: JournalEntry;
    if (due) {
      const p = structuredClone(project);
      e = { id: `${this.projectId}:${seq}`, projectId: this.projectId, seq, at, kind: 'checkpoint', label, source, project: p, size: sizeOf(p) };
      this.sinceCheckpoint = 0;
      this.lastCheckpointAt = at;
    } else {
      e = { id: `${this.projectId}:${seq}`, projectId: this.projectId, seq, at, kind: 'entry', label, source, patch: patch!, size: sizeOf(patch) };
      this.sinceCheckpoint++;
    }
    this.entries.push(e);
    this.head = structuredClone(project);
    await this.store.put([e]);
    return e;
  }

  private stateAtIndex(i: number): Project {
    let cp = i;
    while (cp >= 0 && this.entries[cp].kind !== 'checkpoint') cp--;
    if (cp < 0) throw new Error('The journal has no checkpoint before this point');
    let p = structuredClone(this.entries[cp].project!);
    for (let k = cp + 1; k <= i; k++) p = apply(p, this.entries[k].patch!);
    return p;
  }

  /** The song as it was at `time` (the last recorded state at or before it); null before the journal starts. */
  stateAt(time: number): { project: Project; entry: JournalEntry } | null {
    let i = -1;
    for (let k = 0; k < this.entries.length && this.entries[k].at <= time; k++) i = k;
    if (i < 0) return null;
    return { project: this.stateAtIndex(i), entry: this.entries[i] };
  }

  timeline(from = 0, to = Infinity) {
    return this.entries.filter((e) => e.at >= from && e.at <= to).map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, label: e.label, source: e.source }));
  }

  /**
   * Retention: drop what is older than maxAgeMs, or the oldest part beyond maxBytes, keeping the state
   * at the new start as a checkpoint so everything after it can still be rebuilt.
   */
  async compact(now = Date.now()) {
    if (this.entries.length < 2) return 0;
    let cut = this.entries.findIndex((e) => e.at >= now - this.opts.maxAgeMs);
    if (cut < 0) cut = this.entries.length - 1;
    let total = this.entries.slice(cut).reduce((n, e) => n + e.size, 0);
    while (total > this.opts.maxBytes && cut < this.entries.length - 1) total -= this.entries[cut++].size;
    if (cut <= 0) return 0;
    const first = this.entries[cut];
    const keep: JournalEntry = first.kind === 'checkpoint' ? first : { ...first, kind: 'checkpoint', patch: undefined, project: this.stateAtIndex(cut), size: 0 };
    keep.size = keep.size || sizeOf(keep.project);
    const dropped = this.entries.slice(0, cut).map((e) => e.id);
    this.entries = [keep, ...this.entries.slice(cut + 1)];
    await this.store.put([keep]);
    await this.store.remove(dropped);
    return dropped.length;
  }
}
