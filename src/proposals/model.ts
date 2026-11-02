// Musical pull requests (C1). Pure: the model, what changed in bars, and the .openband-pr file.
import { gunzipSync, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { AnnotationAuthor, LedgerEntry, Project } from '../types';
import { projectSampleIdsOf } from '../storage/samplesOf';
import { BEATS_PER_BAR } from '../music';
import type { ProjectDiff } from '../versions/diff';
import type { TestRun } from '../tests/types';

export interface Proposal {
  id: string;
  number: number;
  projectId: string;
  title: string;
  description?: string;
  author: AnnotationAuthor;
  baseVersionId: string;
  headVersionId: string;
  status: 'open' | 'merged' | 'closed' | 'draft';
  createdAt: number;
  updatedAt: number;
  reviews?: { by: AnnotationAuthor; verdict: 'approve' | 'changes' | 'comment'; at: number; text?: string }[];
  checks?: { tests?: TestRun; lint?: { added: number; removed: number } };
  mergedVersionId?: string;
}

export const MAX_DESCRIPTION = 2000;
export const nextNumber = (p: Project) => Math.max(0, ...(p.proposals ?? []).map((x) => x.number)) + 1;

const barOf = (beat: number) => Math.floor(beat / BEATS_PER_BAR) + 1;

/** Bars touched by a diff, sorted and merged into ranges. Everything in `head`'s timeline. */
export function changedBars(d: ProjectDiff, head: Project): { from: number; to: number }[] {
  const bars = new Set<number>();
  const mark = (start: number, length: number) => {
    for (let b = barOf(start); b <= barOf(start + Math.max(0, length - 1e-6)); b++) bars.add(b);
  };
  for (const r of [...d.regions.added, ...d.regions.removed]) mark(r.start, r.length);
  for (const c of d.regions.changed) {
    const r = head.regions.find((x) => x.id === c.id);
    if (!r) continue;
    if (!c.notes) mark(r.start, r.length);
    else
      for (const n of [...c.notes.added, ...c.notes.removed, ...c.notes.changed.map((x) => x.to)]) mark(r.start + n.start, n.duration);
  }
  const sorted = [...bars].sort((a, b) => a - b);
  const out: { from: number; to: number }[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && last.to + 1 >= b) last.to = b;
    else out.push({ from: b, to: b });
  }
  return out;
}

const sectionAt = (p: Project, beat: number) => p.sections?.find((s) => beat >= s.start && beat < s.start + s.length);

/** "Basso: 34 notes changed in Ritornello; new track Organo; tempo 92 → 94". */
export function readableChanges(d: ProjectDiff, head: Project): string[] {
  const out: string[] = [];
  for (const t of d.tracks.added) out.push(`New track ${t.name}`);
  for (const t of d.tracks.removed) out.push(`Removed track ${t.name}`);
  const nameOf = (id: string) => head.tracks.find((t) => t.id === id)?.name ?? id;
  const perTrack = new Map<string, { notes: number; sections: Set<string> }>();
  for (const c of d.regions.changed) {
    if (!c.notes) continue;
    const r = head.regions.find((x) => x.id === c.id);
    const n = c.notes.added.length + c.notes.removed.length + c.notes.changed.length;
    if (!n || !r) continue;
    const e = perTrack.get(c.track_id) ?? { notes: 0, sections: new Set<string>() };
    e.notes += n;
    for (const x of [...c.notes.added, ...c.notes.changed.map((y) => y.to)]) {
      const s = sectionAt(head, r.start + x.start);
      if (s) e.sections.add(s.name);
    }
    perTrack.set(c.track_id, e);
  }
  for (const [id, e] of perTrack) out.push(`${nameOf(id)}: ${e.notes} notes changed${e.sections.size ? ` in ${[...e.sections].join(', ')}` : ''}`);
  for (const r of d.regions.added) if (!d.tracks.added.some((t) => t.id === r.trackId)) out.push(`New region ${r.name} on ${nameOf(r.trackId)}`);
  for (const [k, v] of Object.entries(d.project)) out.push(`${k} ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`);
  return out;
}

export interface ProposalFile {
  proposal: Proposal;
  head: Project;
  base?: Project;
  forkOf?: Project['meta'] extends infer M ? (M extends { forkOf?: infer F } ? F : never) : never;
  ledger: LedgerEntry[];
  samples: { id: string; name: string; type: string; data: Uint8Array }[];
}

/** A .openband-pr: the proposal, the head and base, and only the samples the base doesn't have. */
export function packProposal(f: ProposalFile) {
  const baseSamples = new Set(f.base ? projectSampleIdsOf(f.base) : []);
  const fresh = f.samples.filter((s) => !baseSamples.has(s.id));
  const files: Record<string, Uint8Array> = {
    'proposal.json': strToU8(JSON.stringify(f.proposal, null, 2)),
    'head.json.gz': gzipSync(strToU8(JSON.stringify(f.head)), { mtime: 0 }),
    'ledger.json': strToU8(JSON.stringify(f.ledger)),
    'forkOf.json': strToU8(JSON.stringify(f.forkOf ?? null)),
    'samples.json': strToU8(JSON.stringify(fresh.map(({ data: _, ...m }) => m))),
  };
  if (f.base) files['base.json.gz'] = gzipSync(strToU8(JSON.stringify(f.base)), { mtime: 0 });
  for (const s of fresh) files[`samples/${s.id}`] = s.data;
  return zipSync(files, { level: 0 });
}

export function unpackProposal(bytes: Uint8Array): ProposalFile {
  const z = unzipSync(bytes);
  if (!z['proposal.json'] || !z['head.json.gz']) throw new Error('This is not an OpenBand proposal');
  const json = <T,>(name: string, fallback: T): T => (z[name] ? (JSON.parse(strFromU8(z[name])) as T) : fallback);
  const gz = (name: string) => (z[name] ? (JSON.parse(strFromU8(gunzipSync(z[name]))) as Project) : undefined);
  const meta = json<{ id: string; name: string; type: string }[]>('samples.json', []);
  return { proposal: json('proposal.json', {} as Proposal), head: gz('head.json.gz')!, base: gz('base.json.gz'), forkOf: json('forkOf.json', undefined), ledger: json('ledger.json', []), samples: meta.map((m) => ({ ...m, data: z[`samples/${m.id}`] })).filter((s) => s.data) };
}
