// Proposals in the studio: fork, propose, review, merge. The diff, the merge and the versions are F13's.
import { create } from 'zustand';
import { getStoredSample, importSample, ensureSamples, sampleName } from '../audio/samples';
import { BEATS_PER_BAR, uid } from '../music';
import { backend } from '../storage';
import { projectSampleIdsOf } from '../storage/samplesOf';
import { useStore } from '../store';
import type { Annotation, AnnotationAuthor, Project } from '../types';
import { createBranch, getSnapshot, listVersions, loadVersions, mergeBranch, saveVersion, useVersions } from '../versioning';
import { diffProjects } from '../versions/diff';
import { gzipSync, strToU8 } from 'fflate';
import { MAX_DESCRIPTION, changedBars, nextNumber, packProposal, readableChanges, unpackProposal, type Proposal } from './model';

const st = () => useStore.getState();
const me = (ai: boolean): AnnotationAuthor => ({ name: ai ? 'AI' : 'Me', kind: ai ? 'ai' : 'user' }) as AnnotationAuthor;
const pidOf = (p: Project) => p.meta?.projectId ?? 'local';
const find = (number: unknown) => {
  const x = st().project.proposals?.find((y) => y.number === Number(number));
  if (!x) throw new Error(`Proposal #${number} not found. Call list_proposals.`);
  return x;
};
const update = (n: number, change: Partial<Proposal>, label: string) =>
  st().commit((d) => void (d.proposals = d.proposals!.map((x) => (x.number === n ? { ...x, ...change, updatedAt: Date.now() } : x))), { label });

/** Merging needs a person in the studio, as publishing does. */
export const useMergeConfirm = create<{ ask: { number: number; title: string; resolve: (ok: boolean) => void } | null }>(() => ({ ask: null }));
function confirmMerge(number: number, title: string, timeoutMs = 5 * 60000) {
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      useMergeConfirm.setState({ ask: null });
      resolve(ok);
    };
    useMergeConfirm.setState({ ask: { number, title, resolve: done } });
    setTimeout(() => useMergeConfirm.getState().ask?.resolve === done && done(false), timeoutMs);
  });
}

export async function forkProject(name?: string) {
  const origin = st().project;
  const at = useVersions.getState().headId ?? (await saveVersion('Fork point', 'user')).id;
  const fork = structuredClone(origin);
  fork.name = name || `${origin.name} (fork)`;
  fork.meta = { createdAt: Date.now(), updatedAt: Date.now(), projectId: uid('song'), forkOf: { projectId: pidOf(origin), versionId: at, name: origin.name } };
  fork.proposals = [];
  st().loadProject(fork);
  await loadVersions();
  return { project_id: fork.meta.projectId, fork_of: fork.meta.forkOf };
}

export async function createProposal(a: { title: string; description?: string; base?: string; head?: string }, ai: boolean) {
  const p = st().project;
  const title = a.title?.trim();
  if (!title) throw new Error('A proposal needs a title');
  if ((a.description ?? '').length > MAX_DESCRIPTION) throw new Error(`The description is at most ${MAX_DESCRIPTION} characters`);
  const fork = p.meta?.forkOf;
  const head = a.head ?? (await saveVersion(title, ai ? 'ai' : 'user')).id;
  const base = a.base ?? fork?.versionId ?? useVersions.getState().versions.find((v) => v.id === head)?.parentIds[0];
  if (!base) throw new Error('No base version: save a version first, or name one in base');
  const number = nextNumber(p);
  const x: Proposal = { id: uid('pr'), number, projectId: fork?.projectId ?? pidOf(p), title, description: a.description, author: me(ai), baseVersionId: base, headVersionId: head, status: 'open', createdAt: Date.now(), updatedAt: Date.now() };
  st().commit((d) => void (d.proposals = [...(d.proposals ?? []), x]), { label: `Proposal #${number}` });
  if (!fork) await createBranch(`pr/${number}`, head);
  return { number, id: x.id };
}

/** What a proposal changes: the head against the base, in words and bars. */
export async function proposalChanges(x: Proposal) {
  const [base, head] = await Promise.all([getSnapshot(x.baseVersionId), getSnapshot(x.headVersionId)]);
  const diff = diffProjects(base, head);
  return { base, head, diff, summary: readableChanges(diff, head), bars: changedBars(diff, head) };
}

export const listProposals = (status?: string) => (st().project.proposals ?? []).filter((x) => !status || x.status === status).map(({ number, title, status: s, author, updatedAt }) => ({ number, title, status: s, author: author.name, updated_at: updatedAt }));

export async function getProposal(number: unknown) {
  const x = find(number);
  const c = await proposalChanges(x);
  const threads = (st().project.annotations ?? []).filter((a) => a.proposalId === x.id).map((a) => ({ id: a.id, by: a.author.name, text: a.text, target: a.target, resolved: !!a.resolved }));
  return { ...x, summary: c.summary, bars: c.bars, threads };
}

export function commentProposal(a: { number: unknown; text: string; bar_from?: number; bar_to?: number; track?: string }, ai: boolean) {
  const x = find(a.number);
  const text = String(a.text ?? '').trim();
  if (!text) throw new Error('text is empty');
  const from = Number(a.bar_from ?? 1);
  const to = Number(a.bar_to ?? from);
  const note: Annotation = { id: uid('ann'), proposalId: x.id, target: { type: 'range', from_beat: (from - 1) * BEATS_PER_BAR, to_beat: to * BEATS_PER_BAR }, text, author: me(ai), createdAt: Date.now() };
  st().commit((d) => void (d.annotations = [...(d.annotations ?? []), note]), { label: `Comment on #${x.number}` });
  return { annotation_id: note.id };
}

export function reviewProposal(a: { number: unknown; verdict: 'approve' | 'changes' | 'comment'; text?: string }, ai: boolean) {
  const x = find(a.number);
  update(x.number, { reviews: [...(x.reviews ?? []), { by: me(ai), verdict: a.verdict, at: Date.now(), text: a.text }] }, `Review of #${x.number}`);
  return { number: x.number, reviews: (x.reviews?.length ?? 0) + 1 };
}

export const closeProposal = (number: unknown) => {
  const x = find(number);
  update(x.number, { status: 'closed' }, `Close #${x.number}`);
  return { number: x.number, status: 'closed' };
};

export async function mergeProposal(a: { number: unknown; picks?: { entity: string; id: string; from: 'a' | 'b' }[]; strategy?: 'manual' | 'ours' | 'theirs' }, ai: boolean) {
  const x = find(a.number);
  if (x.status !== 'open') throw new Error(`Proposal #${x.number} is ${x.status}`);
  if (!(await confirmMerge(x.number, x.title))) throw new Error('Not merged: the user did not confirm it in the studio.');
  const before = st().project;
  const tx = st().beginTransaction(`Merge #${x.number}: ${x.title}`, ai ? 'ai' : 'ui');
  try {
    const onlyPicks = !!a.picks?.length;
    const r = await mergeBranch(`pr/${x.number}`, a.strategy ?? 'manual', (a.picks ?? []) as never, ai ? 'ai' : 'user', onlyPicks);
    if (r.conflicts.length && !r.version_id) return { number: x.number, conflicts: r.conflicts };
    const known = new Set(before.regions.map((reg) => reg.id));
    const fresh = st().project.regions.filter((reg) => !known.has(reg.id));
    st().commit((d) => {
      d.proposals = d.proposals!.map((y) => (y.number === x.number ? { ...y, status: 'merged', mergedVersionId: r.version_id, updatedAt: Date.now() } : y));
      if (fresh.length) d.ledger = [...(d.ledger ?? []), ...[...new Set(fresh.map((f) => f.trackId))].map((trackId) => ({ id: uid('led'), at: Date.now(), source: 'human' as const, contributor: { name: x.author.name }, engine: 'human', capability: 'proposal', requestedBy: 'user' as const, conform: [], license: { code: 'unknown', weights: null, commercial: 'conditional' as const }, trackId, regionIds: fresh.filter((f) => f.trackId === trackId).map((f) => f.id) }))];
    });
    return { number: x.number, merged: true, version_id: r.version_id, conflicts: r.conflicts };
  } finally {
    st().endTransaction(tx);
  }
}

/** The file to send. Only samples new to the base travel. */
export async function exportProposal(number: unknown) {
  const x = find(number);
  const [base, head] = await Promise.all([getSnapshot(x.baseVersionId).catch(() => undefined), getSnapshot(x.headVersionId)]);
  const ids = [...new Set(projectSampleIdsOf(head))];
  await ensureSamples(ids);
  const samples = ids.flatMap((id) => {
    const s = getStoredSample(id);
    return s ? [{ id, name: s.name, type: s.type, data: new Uint8Array(s.data) }] : [];
  });
  const file = packProposal({ proposal: x, head, base, forkOf: st().project.meta?.forkOf, ledger: head.ledger ?? [], samples });
  return { bytes: file, filename: `${st().project.name} #${x.number}.openband-pr` };
}

/** Into the song it was made from; anywhere else, it opens as a fork. */
export async function importProposal(bytes: Uint8Array) {
  const f = unpackProposal(bytes);
  for (const s of f.samples) await importSample(s.data.slice().buffer, s.name || sampleName(s.id), s.type);
  const p = st().project;
  if (pidOf(p) !== f.proposal.projectId) {
    const fork = structuredClone(f.head);
    fork.meta = { createdAt: Date.now(), updatedAt: Date.now(), projectId: uid('song'), forkOf: { projectId: f.proposal.projectId, versionId: f.proposal.baseVersionId, name: f.forkOf?.name ?? f.head.name } };
    st().loadProject(fork);
    await loadVersions();
    return { opened_as_fork: true, title: f.proposal.title };
  }
  const number = nextNumber(p);
  const headId = uid('ver');
  const known = await backend().versions.get(f.proposal.baseVersionId);
  if (!known) throw new Error('This proposal starts from a version this song does not have');
  await backend().versions.put({ id: headId, projectId: pidOf(p), parentIds: [f.proposal.baseVersionId], branch: `pr/${number}`, label: f.proposal.title, createdAt: Date.now(), author: 'user', snapshot: gzipSync(strToU8(JSON.stringify(f.head)), { mtime: 0 }) });
  await backend().versions.putBranch({ id: `${pidOf(p)}:pr/${number}`, projectId: pidOf(p), name: `pr/${number}`, headId, at: Date.now() });
  const x: Proposal = { ...f.proposal, id: uid('pr'), number, headVersionId: headId, status: 'open', updatedAt: Date.now() };
  st().commit((d) => void (d.proposals = [...(d.proposals ?? []), x]), { label: `Proposal #${number}` });
  await loadVersions();
  return { number, title: x.title, from: x.author.name };
}

export { listVersions };
