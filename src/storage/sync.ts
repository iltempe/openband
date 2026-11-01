// The studio and the library on a server: connecting, opening, moving songs, and what to do when two
// devices disagree. The HTTP part is in server.ts; this is the part that knows about the open song.
import { create } from 'zustand';
import { desktop } from '../desktop';
import { idbKeyStore } from '../ai/keys';
import { useCollab } from '../collab/session';
import { useStore } from '../store';
import { loadVersions, saveBranchFrom, saveVersion } from '../versioning';
import { t } from '../i18n';
import type { Project } from '../types';
import { backend, setBackend } from '.';
import { LocalBackend, readAutosave } from './local';
import { PREFIX, ServerBackend, type Kv } from './server';
import type { BackendStatus, ProjectSummary } from './types';

const URL_KEY = 'openband.store.url';
const INSTANCE_KEY = 'openband.store.instance';
const MIGRATED_KEY = 'openband.store.migrated';
const DEVICE_KEY = 'openband.store.device';
const tokenRecord = (url: string) => `store-token:${url}`;

export interface StoreLink {
  url: string | null;
  name: string | null;
  /** The library of this computer (desktop, or a local server): every song lives there. */
  own: boolean;
  status: BackendStatus;
  space: { used: number; quota: number } | null;
  /** The last conflict: the local work is safe on this branch. */
  conflict: { branch: string; versionId: string; project: string } | null;
}
export const useStoreLink = create<StoreLink>(() => ({ url: null, name: null, own: false, status: LocalBackend.status(), space: null, conflict: null }));

const kv: Kv = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not kept */
    }
  },
};

/** A short name for this browser, used in conflict branches ("a3f9"). */
function deviceName() {
  let d = kv.get(DEVICE_KEY);
  if (!d) {
    d = Math.random().toString(36).slice(2, 6);
    kv.set(DEVICE_KEY, d);
  }
  return d;
}

/** This page, in events: its own writes come back on the channel and must not look like another device's. */
const pageId = `${deviceName()}-${Math.random().toString(36).slice(2, 8)}`;

const server = () => (backend() instanceof ServerBackend ? (backend() as ServerBackend) : null);
const idOf = (p: Project) => p.meta?.projectId ?? 'local';
const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

/** Two devices wrote the same song: mine goes on its own branch, the server's becomes the working copy. Nothing is lost. */
async function handleConflict(mine: Project) {
  const b = server();
  if (!b) return;
  const id = idOf(mine);
  const branch = `conflitto-${deviceName()}-${stamp()}`;
  const versionId = await saveBranchFrom(branch, mine, t('st.conflictLabel'));
  const theirs = await b.projects.get(id);
  if (theirs) {
    b.resolved(id, theirs.etag);
    await b.pull(id);
    if (idOf(useStore.getState().project) === id) useStore.getState().loadProject(theirs.value);
    await loadVersions();
  }
  useStoreLink.setState({ conflict: { branch, versionId, project: id } });
  useStore.getState().notify(t('st.conflict'));
}

let socket: WebSocket | null = null;
let retry: ReturnType<typeof setInterval> | undefined;

function listen(b: ServerBackend, token: string | undefined, instance: string | undefined) {
  socket?.close();
  const url = `${b.url.replace(/^http/, 'ws')}${PREFIX}/events`;
  const ws = new WebSocket(url, ['openband-store', ...(token ? [`bearer.${token}`] : []), ...(instance ? [`instance.${instance}`] : [])]);
  socket = ws;
  ws.onopen = () => void b.flush();
  ws.onmessage = (m) => void onEvent(b, JSON.parse(String(m.data))).catch((e) => console.warn('[openband] store:', (e as Error).message));
  ws.onclose = () => {
    if (socket === ws) setTimeout(() => socket === ws && backend() === b && listen(b, token, instance), 5000);
  };
}

/** Another device changed the open song: follow it, unless there is work here still to send (then a conflict decides). */
async function onEvent(b: ServerBackend, e: { kind: string; id?: string; etag?: string | null; by?: string }) {
  if (e.kind !== 'project_changed' || !e.id || !e.etag || e.by === pageId) return;
  if (idOf(useStore.getState().project) !== e.id || b.etagOf(e.id) === e.etag) return;
  if (useCollab.getState().room) return b.followed(e.id, e.etag);
  if (b.pending()) return;
  const fresh = await b.projects.get(e.id);
  if (!fresh) return;
  useStore.getState().loadProject(fresh.value);
  await b.pull(e.id).catch(() => null);
  await loadVersions();
}

function attach(url: string, token: string | undefined, instance: string | undefined, own = false) {
  const b = new ServerBackend({
    url,
    token,
    instanceToken: instance,
    client: pageId,
    own,
    keepOut: untouched,
    scope: own ? 'own' : undefined,
    cache: LocalBackend,
    kv,
    onConflict: (mine) => void handleConflict(mine),
    paused: () => !!useCollab.getState().room,
    onStatus: (status) => useStoreLink.setState({ status }),
  });
  setBackend(b);
  listen(b, token, instance);
  clearInterval(retry);
  retry = setInterval(() => b.pending() && void b.flush(), 5000);
  window.addEventListener('online', () => backend() === b && void b.flush());
  useStoreLink.setState({ url: b.url, own, status: b.status(), conflict: null });
  void b.flush();
  void refreshSpace();
  if (own) useStoreLink.setState({ name: t('st.thisComputer') });
  else
    void fetch(`${b.url}/config.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => useStoreLink.setState({ name: c?.instanceName || new URL(b.url).host }))
      .catch(() => useStoreLink.setState({ name: new URL(b.url).host }));
  return b;
}

export async function refreshSpace() {
  const b = server();
  if (!b) return useStoreLink.setState({ space: null });
  await b.space().then((space) => useStoreLink.setState({ space })).catch(() => null);
}

/** Connect to a server; `code` is its pairing code when it asks for one. */
export async function connectServer(rawUrl: string, code?: string, instance?: string) {
  const url = rawUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new Error(t('st.badUrl'));
  // A page on https cannot reach http (the browser refuses): say so instead of a network error.
  if (location.protocol === 'https:' && url.startsWith('http:')) throw new Error(t('st.needHttps'));
  const headers = instance ? { 'x-store-token': instance } : undefined;
  let token = (await idbKeyStore.get(tokenRecord(url)).catch(() => null)) ?? undefined;
  let r: Response;
  try {
    r = await fetch(`${url}${PREFIX}/status`, { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  } catch {
    throw new Error(t('st.unreachable'));
  }
  if (r.status === 401) {
    if (!code) throw new Error(t('st.needCode'));
    const p = await fetch(`${url}${PREFIX}/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    if (!p.ok) throw new Error(t('st.badCode'));
    token = ((await p.json()) as { token: string }).token;
    await idbKeyStore.set(token, tokenRecord(url));
  } else if (!r.ok) throw new Error(t('st.refused'));
  kv.set(URL_KEY, url);
  if (instance) kv.set(INSTANCE_KEY, instance);
  attach(url, token, instance);
}

export function disconnectServer() {
  const s = socket;
  socket = null;
  s?.close();
  clearInterval(retry);
  setBackend(LocalBackend);
  try {
    localStorage.removeItem(URL_KEY);
  } catch {
    /* nothing to remove */
  }
  useStoreLink.setState({ url: null, name: null, own: false, space: null, status: LocalBackend.status() });
  void connectOwn();
}

/** The library of this computer: the desktop's, or that of the server this page came from on localhost. */
async function ownStore() {
  if (desktop) return desktop.storeUrl ?? null;
  if (!['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol !== 'http:') return null;
  const r = await fetch(`${location.origin}${PREFIX}/status`).catch(() => null);
  if (!r?.ok) return null;
  // Without a store this address is the app's own index.html.
  const status = (await r.json().catch(() => null)) as { own?: boolean } | null;
  return status?.own ? location.origin : null;
}

/** The song a new browser starts with: until someone changes it, it isn't anybody's song. */
let demo: { id: string; steps: number } | null = null;
export const markDemo = (p: Project) => void (demo = { id: idOf(p), steps: useStore.getState().past.length });
const untouched = (p: Project) => !p.tracks.length || (idOf(p) === demo?.id && useStore.getState().past.length === demo.steps);

/** First run with a library: copy every song of this browser there. The originals stay. */
async function migrate(b: ServerBackend) {
  if (kv.get(MIGRATED_KEY)) return;
  let n = 0;
  for (const s of await LocalBackend.projects.list()) {
    const got = await LocalBackend.projects.get(s.id);
    if (!got || untouched(got.value)) continue;
    await b.adopt(got.value);
    n++;
  }
  kv.set(MIGRATED_KEY, String(Date.now()));
  if (n) useStore.getState().notify(t('st.migrated', { n }));
}

async function connectOwn() {
  const startedWith = idOf(useStore.getState().project);
  const url = await ownStore();
  if (!url) return;
  const b = attach(url, undefined, undefined, true);
  await migrate(b).catch((e) => console.warn('[openband] store:', (e as Error).message));
  // The browser's data was cleared: the library still has the songs.
  const [latest] = await b.projects.list();
  // Only if nothing has happened yet: a song someone started meanwhile, even an empty one, stays open.
  const now = useStore.getState().project;
  if (latest && idOf(now) === startedWith && untouched(now)) await openProject(latest.id).catch(() => null);
}

/** At start: back to the server this browser was connected to. It works offline too. */
export async function restoreServer() {
  const url = kv.get(URL_KEY);
  if (!url) return connectOwn();
  attach(url, (await idbKeyStore.get(tokenRecord(url)).catch(() => null)) ?? undefined, kv.get(INSTANCE_KEY) ?? undefined);
}

export interface ListedProject extends ProjectSummary {
  open: boolean;
  /** The server's copy has changes not here, or this one has changes not there. */
  state?: BackendStatus['state'];
}

/** Both sections of the panel. A server song this browser also caches is listed once, as the server's. */
export async function listProjects(): Promise<ListedProject[]> {
  const b = server();
  const remote = b ? await b.projects.list() : [];
  const seen = new Set(remote.map((p) => p.id));
  const local = (await LocalBackend.projects.list()).filter((p) => !seen.has(p.id) && !b?.tracked(p.id));
  const open = idOf(useStore.getState().project);
  return [...local, ...remote].map((p) => ({ ...p, open: p.id === open, ...(p.source === 'server' && b ? { state: p.id === open ? b.status().state : 'ready' } : {}) }));
}

/** The browser keeps one working song: before replacing it, what isn't on a server becomes a version, so it stays in the list. */
async function keepCurrent() {
  const b = server();
  const p = useStore.getState().project;
  if (p.tracks.length && !b?.tracked(idOf(p)) && !useStoreLink.getState().own) await saveVersion(t('st.beforeOpen'), 'user');
}

export async function openProject(id: string) {
  const b = server();
  if (idOf(useStore.getState().project) === id) return { id, already_open: true };
  if (b?.pending()) throw new Error(t('st.waitSync'));
  const fromServer = b ? await b.projects.get(id) : null;
  const stored = fromServer ?? (await LocalBackend.projects.get(id));
  if (!stored) throw new Error(`No project "${id}". Call list_projects.`);
  await keepCurrent();
  if (fromServer) await b!.pull(id).catch(() => null);
  useStore.getState().loadProject(stored.value);
  await loadVersions();
  return { id, name: stored.value.name, source: fromServer ? 'server' : 'local' };
}

export async function moveProject(id: string, to: 'server' | 'local') {
  const b = server();
  if (!b) throw new Error(t('st.noServer'));
  await openProject(id);
  if (to === 'server') {
    await b.adopt(useStore.getState().project);
    await refreshSpace();
  } else {
    await b.pull(id);
    b.forget(id);
  }
  return { id, to };
}

export async function storeStatus() {
  const s = useStoreLink.getState();
  await refreshSpace();
  const { space } = useStoreLink.getState();
  return { backend: s.url ? 'server' : 'local', url: s.url, name: s.name, state: backend().status().state, pending: server()?.pending() ?? 0, used_bytes: space?.used, quota_bytes: space?.quota, offline_autosave: readAutosave() !== null };
}
