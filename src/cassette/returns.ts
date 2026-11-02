// Returns in the studio (D2.5). They stay on this instance: in the browser, or on the musician's own disk.
import { create } from 'zustand';
import { importSample } from '../audio/samples';
import { BEATS_PER_BAR, uid } from '../music';
import { backend } from '../storage';
import { tx } from '../storage/idb';
import { ServerBackend } from '../storage/server';
import { useStore } from '../store';
import type { Annotation, Project } from '../types';
import { getSnapshot } from '../versioning';
import { getCassette, identity, listCassettes } from './burn';
import { fingerprint, fromB64u } from './crypto';
import type { CassetteTrack } from './format';
import { listenP2P, returnsRoom } from './p2p';
import { anchorOf, reanchor, secondsToBeat, type MusicalAnchor } from './reanchor';
import { listenerState, openReply, type Reply, type ReplyBox, type ReplyItem } from './reply';

export interface StoredReturn {
  id: string;
  seriesId: string;
  edition: number;
  trackId: string;
  trackTitle: string;
  projectId: string;
  from: string;
  fromKey: string;
  via?: string;
  createdAt: number;
  items: (ReplyItem & { anchor?: MusicalAnchor })[];
  /** The name was known with another key: the musician accepts or refuses. */
  pending?: boolean;
}

const KNOWN = 'openband.cassette.listeners';
const known = (): Record<string, string> => JSON.parse(localStorage.getItem(KNOWN) ?? '{}') as Record<string, string>;
export const useReturns = create<{ list: StoredReturn[]; note: string | null }>(() => ({ list: [], note: null }));

export const refreshReturns = async () => useReturns.setState({ list: ((await tx<StoredReturn[]>('returns', 'readonly', (s) => s.getAll())) ?? []).sort((a, b) => b.createdAt - a.createdAt) });

const trackOf = (tracks: CassetteTrack[], id: string) => tracks.find((t) => t.id === id);

/** A reaction's bars on the song as it is now: F14 pins, with the listener's name. */
async function pin(r: StoredReturn, base: Project) {
  const p = useStore.getState().project;
  if (p.meta?.projectId !== r.projectId) return;
  const notes: Annotation[] = [];
  for (const it of r.items) {
    if (it.kind === 'listen' || it.kind === 'overdub' || !it.anchor) continue;
    const at = reanchor(it.anchor, base, p);
    if ('orphan' in at) continue;
    const text = it.kind === 'reaction' ? it.label : it.kind === 'comment' ? it.text : '🎙';
    notes.push({ id: uid('ann'), target: { type: 'range', from_beat: at.beat, to_beat: at.beat + BEATS_PER_BAR }, text, author: { kind: 'user', name: r.from }, createdAt: r.createdAt });
  }
  if (notes.length) useStore.getState().commit((d) => void (d.annotations = [...(d.annotations ?? []), ...notes]), { label: `Returns from ${r.from}` });
}

/** A sealed packet, by any road. Anything that doesn't open or isn't for a known cassette is dropped in silence. */
export async function intake(text: string) {
  const box = JSON.parse(text) as ReplyBox;
  const id = await identity();
  const { reply, signed } = await openReply(box, id.box.privateKey);
  if (!signed) throw new Error('A return with a broken signature was refused');
  const c = await getCassette(`${reply.seriesId}:${reply.edition}`);
  if (!c) throw new Error('A return for a cassette this studio does not know');
  const track = trackOf(c.manifest.sides.flatMap((s) => s.tracks), reply.trackId);
  if (!track) throw new Error('A return for a song not on that cassette');
  const print = await fingerprint(reply.from.key);
  const state = listenerState(known(), reply.from.name, print);
  if (state === 'new') localStorage.setItem(KNOWN, JSON.stringify({ ...known(), [reply.from.name]: print }));
  const base = await getSnapshot(reply.versionId).catch(() => null);
  const items = (reply.items as Reply['items']).map((it) => (base && 't' in it ? { ...it, anchor: anchorOf(base, reply.versionId, secondsToBeat(track.beatMap, it.t)) } : it));
  const stored: StoredReturn = { id: reply.id, seriesId: reply.seriesId, edition: reply.edition, trackId: reply.trackId, trackTitle: track.title, projectId: track.projectId, from: reply.from.name, fromKey: print, via: reply.via, createdAt: reply.createdAt, items, pending: state === 'changed' };
  for (const it of stored.items) if (it.kind === 'voice') await importSample(fromB64u(it.blob).buffer as ArrayBuffer, `Voice note from ${stored.from}`, it.type);
  await tx('returns', 'readwrite', (s) => s.put(stored));
  if (state === 'changed') useReturns.setState({ note: `${stored.from}?` });
  else if (base) await pin(stored, base);
  await refreshReturns();
  return stored;
}

export async function decide(id: string, accept: boolean) {
  const r = (await tx<StoredReturn | undefined>('returns', 'readonly', (s) => s.get(id))) ?? null;
  if (!r) return;
  if (!accept) await tx('returns', 'readwrite', (s) => s.delete(id));
  else {
    localStorage.setItem(KNOWN, JSON.stringify({ ...known(), [r.from]: r.fromKey }));
    const clean = { ...r, pending: false };
    await tx('returns', 'readwrite', (s) => s.put(clean));
    const base = await getSnapshot(r.items.find((x) => 'anchor' in x)?.anchor?.versionId ?? '').catch(() => null);
    if (base) await pin(clean, base);
  }
  useReturns.setState({ note: null });
  await refreshReturns();
}

/** Where people reacted, and where they stopped: a value per bucket of a song. Pure. */
export function heatmap(returns: Pick<StoredReturn, 'items'>[], durationS: number, buckets = 40) {
  const hot = new Array<number>(buckets).fill(0);
  const heard = new Array<number>(buckets).fill(0);
  const at = (t: number) => Math.min(buckets - 1, Math.max(0, Math.floor((t / durationS) * buckets)));
  for (const r of returns)
    for (const it of r.items) {
      if (it.kind === 'reaction' || it.kind === 'comment' || it.kind === 'voice') hot[at(it.t)]++;
      if (it.kind === 'listen') for (const [a, b] of it.segments) for (let i = at(a); i <= at(b); i++) heard[i]++;
    }
  return { hot, heard };
}

/** Whatever the instance's inbox holds comes here, and leaves the server. */
export async function drainInbox() {
  const b = backend();
  if (!(b instanceof ServerBackend)) return;
  const r = await b.req('/cassettes/inbox').catch(() => null);
  if (!r?.ok) return;
  for (const id of (await r.json()) as string[]) {
    const p = await b.req(`/cassettes/packet/${id}`);
    await intake(await p.text()).catch((e) => console.warn('[openband] return:', (e as Error).message));
    await b.req(`/inbox-done/${id}`, { method: 'POST' });
  }
}

let stops: (() => void)[] = [];
/** While the studio is open, the P2P road is open. */
export async function listenForReturns() {
  stops.forEach((s) => s());
  stops = [];
  await drainInbox();
  const latest = new Map((await listCassettes()).map((c) => [c.seriesId, c]));
  for (const c of latest.values())
    for (const r of c.manifest.returns)
      if (r.kind === 'webrtc') stops.push(listenP2P(r.signaling, await returnsRoom(c.key), (text) => void intake(text).catch((e) => console.warn('[openband] return:', (e as Error).message))));
}
