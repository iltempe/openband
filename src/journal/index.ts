// The safety net (F21), live: every closed step (edit, AI request, undo, redo, load) is journaled with
// a patch; after a crash the work done since the last autosave is offered back; the time machine
// rebuilds the song at any instant; destructive operations save a version first.
import { create } from 'zustand';
import type { Project } from '../types';
import { useStore } from '../store';
import { canonicalJSON } from '../versions/canonical';
import { diffProjects } from '../versions/diff';
import { autoVersion, createBranch, checkout, replaceProject, saveVersion, useVersions } from '../versioning';
import { SongJournal, type JournalStore } from './timeline';
import { idbJournal } from './idb';
import { t } from '../i18n';

const st = () => useStore.getState();
const pidOf = (p: Project) => p.meta?.projectId ?? 'local';

export interface Recovery {
  count: number;
  project: Project;
  at: number;
}
export const useJournal = create<{ ready: boolean; recovery: Recovery | null; first: number | null; last: number | null }>(() => ({ ready: false, recovery: null, first: null, last: null }));

let journal: SongJournal | null = null;
let store: JournalStore = idbJournal;
/** Writes in order, one at a time. */
let queue: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>) => (queue = queue.then(fn, fn)) as Promise<T>;

export const journalFor = () => journal;
/** Tests: a memory store instead of IndexedDB. */
export const setJournalStore = (s: JournalStore) => void (store = s);

async function open(projectId: string) {
  const j = await new SongJournal(projectId, store).load();
  await j.compact().catch(() => 0);
  journal = j;
  useJournal.setState({ first: j.entries[0]?.at ?? null, last: j.lastAt || null });
  return j;
}

function record(label: string, source: 'ui' | 'ai' | 'system') {
  const p = st().project;
  const pid = pidOf(p);
  const snap = structuredClone(p);
  const at = Date.now();
  return enqueue(async () => {
    if (!journal || journal.projectId !== pid) await open(pid);
    await journal!.record(snap, label, source, at);
    useJournal.setState({ first: journal!.entries[0]?.at ?? null, last: journal!.lastAt });
  }).catch((e) => console.warn('[openband] journal write failed:', e));
}

/**
 * Start journaling. The autosaved song (already loaded) is compared with the journal: if the journal
 * holds a later state, the recovery banner offers it.
 */
export async function initJournal(o: { autosavedAt?: number } = {}) {
  const p = st().project;
  const autosavedAt = o.autosavedAt ?? p.meta?.updatedAt ?? 0;
  try {
    const j = await enqueue(() => open(pidOf(p)));
    if (j.head && j.lastAt > autosavedAt + 500 && canonicalJSON(j.head) !== canonicalJSON(p)) {
      useJournal.setState({ recovery: { count: j.entries.filter((e) => e.at > autosavedAt).length, project: structuredClone(j.head), at: j.lastAt } });
    } else if (!j.head) await record(t('jr.start'), 'system');
  } catch (e) {
    console.warn('[openband] journal unavailable:', e);
  }
  useJournal.setState({ ready: true });
  useStore.subscribe((s, prev) => {
    if (pidOf(s.project) !== pidOf(prev.project)) return void record(t('jr.opened'), 'system');
    // A step closed (edit, AI request, undo, redo). The journal skips it when nothing actually changed.
    if (s.past === prev.past && s.future === prev.future) return;
    const last = s.past[s.past.length - 1];
    const undo = s.future.length > prev.future.length && s.future[0] !== prev.future[0];
    const redo = s.past.length > prev.past.length && prev.future.length > s.future.length && prev.future[0]?.id === last?.id;
    const label = undo ? `${t('jr.undo')}: ${s.future[0].label}` : redo ? `${t('jr.redo')}: ${last.label}` : (last?.label ?? t('hist.edit'));
    void record(label, undo || redo ? 'ui' : (last?.source ?? 'ui'));
  });
}

export function dismissRecovery() {
  useJournal.setState({ recovery: null });
}

/** Bring back what the journal recovered (one undoable step). */
export function applyRecovery() {
  const r = useJournal.getState().recovery;
  if (!r) return;
  replaceProject(r.project, t('jr.recovered', { n: r.count }));
  useJournal.setState({ recovery: null });
}

// ---------------------------------------------------------------- time machine

async function current() {
  await queue;
  const p = st().project;
  if (!journal || journal.projectId !== pidOf(p)) await enqueue(() => open(pidOf(p)));
  return journal!;
}

export async function timeline(from?: number, to?: number) {
  const j = await current();
  return { first: j.entries[0]?.at ?? null, last: j.lastAt || null, entries: j.timeline(from ?? 0, to ?? Infinity) };
}

/** The song at an instant (ms since epoch), without touching the current one. */
export async function projectAt(time: number) {
  const j = await current();
  const r = j.stateAt(time);
  if (!r) throw new Error(`The journal starts at ${j.entries[0] ? new Date(j.entries[0].at).toISOString() : 'no time yet'}: nothing earlier to show`);
  return r;
}

/** Time machine preview: the compare view with the song as it was (listen, A/B, diff). */
export async function previewInCompare(time: number) {
  const { project, entry } = await projectAt(time);
  const label = t('jr.at', { time: new Date(entry.at).toLocaleTimeString() });
  useVersions.setState({ compare: { versionId: `time:${entry.at}`, label, snapshot: project, diff: diffProjects(project, st().project) } });
  return { project, entry };
}

/** Go back to an instant: replace the song (a version of the current state is saved first), or open it as a new branch. */
export async function restoreAt(time: number, asBranch?: string | boolean, author: 'user' | 'ai' = 'user') {
  const { project, entry } = await projectAt(time);
  const when = new Date(entry.at);
  if (asBranch) {
    const name = typeof asBranch === 'string' && asBranch.trim() ? asBranch.trim() : `at ${when.toTimeString().slice(0, 5).replace(':', '.')}`;
    await autoVersion(`restore to ${when.toLocaleTimeString()}`, st().project, author);
    const v = await saveVersion(t('jr.at', { time: when.toLocaleTimeString() }), author, { project });
    await createBranch(name, v.id);
    await checkout({ branch: name }, author);
    return { restored_at: entry.at, branch: name, version_id: v.id };
  }
  await autoVersion(`restore to ${when.toLocaleTimeString()}`, st().project, author);
  replaceProject(project, t('jr.restored', { time: when.toLocaleTimeString() }));
  useVersions.setState({ compare: null });
  return { restored_at: entry.at, label: entry.label };
}

// ---------------------------------------------------------------- exports never overwrite

const EXPORTS_KEY = 'openband.exportNames';

/** `song.openband`, then `song v2.openband`, `song v3.openband`… for the same name in this browser. */
export function nextExportName(counts: Record<string, number>, base: string, ext: string): { name: string; counts: Record<string, number> } {
  const key = `${base}${ext}`.toLowerCase();
  const n = (counts[key] ?? 0) + 1;
  return { name: n === 1 ? `${base}${ext}` : `${base} v${n}${ext}`, counts: { ...counts, [key]: n } };
}
export function exportName(base: string, ext: string): string {
  let counts: Record<string, number> = {};
  try {
    counts = JSON.parse(localStorage.getItem(EXPORTS_KEY) ?? '{}');
  } catch {
    // fresh
  }
  const r = nextExportName(counts, base, ext);
  try {
    localStorage.setItem(EXPORTS_KEY, JSON.stringify(r.counts));
  } catch {
    // not kept
  }
  return r.name;
}
