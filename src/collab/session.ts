// Multiplayer rooms (F16): one Y.Doc per room, synced over the LAN (the MCP server's relay) or peer to
// peer (WebRTC). The store stays the single source for the UI and the audio engine; this module keeps
// it and the doc in step, shares who's who (awareness), samples, and what the AI does.
import * as Y from 'yjs';
import { getConfig } from '../config';
import { create } from 'zustand';
import type { Project } from '../types';
import { setUndoOverride, useStore } from '../store';
import { engine } from '../audio/engine';
import { getStoredSample, importSample, useSamples } from '../audio/samples';
import { isEmptyDoc, readProject, undoManagerFor, writeProject } from './binding';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  me: boolean;
  host: boolean;
  trackId?: string | null;
  regionId?: string | null;
  position?: number;
  playing?: boolean;
  /** This peer's browser has an AI connected (the AI acts through it). */
  ai?: boolean;
}
export interface RoomActivity {
  peer: string;
  method: string;
  summary: string;
  at: number;
}

interface CollabState {
  room: string | null;
  via: 'lan' | 'p2p' | null;
  status: 'off' | 'connecting' | 'connected';
  peers: Peer[];
  me: { name: string; color: string };
  followHost: boolean;
  isHost: boolean;
  /** What the server told us at bridge connect (null = no LAN relay). */
  server: { lan: string[]; port: number } | null;
  activity: RoomActivity[];
  link: string | null;
}

const COLORS = ['#f472b6', '#60a5fa', '#34d399', '#f59e0b', '#a78bfa', '#22d3ee', '#fb7185', '#facc15'];
const NAME_KEY = 'openband.collab.name';
const savedName = () => {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
};

export const useCollab = create<CollabState>(() => ({
  room: null,
  via: null,
  status: 'off',
  peers: [],
  me: { name: savedName() || `Musician ${Math.floor(Math.random() * 90 + 10)}`, color: COLORS[Math.floor(Math.random() * COLORS.length)] },
  followHost: true,
  isHost: false,
  server: null,
  activity: [],
  link: null,
}));

export const setCollabServer = (server: CollabState['server']) => useCollab.setState({ server });
export function setMyName(name: string) {
  useCollab.setState((s) => ({ me: { ...s.me, name } }));
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // not persisted
  }
  pushAwareness();
}

const LOCAL = { local: true };
const MAX_SAMPLE = 50 * 1024 * 1024;

interface Session {
  doc: Y.Doc;
  provider: { awareness: import('y-protocols/awareness').Awareness; destroy(): void; on(ev: string, fn: (...a: unknown[]) => void): void };
  undo: Y.UndoManager;
  unsub: (() => void)[];
  timer: ReturnType<typeof setInterval>;
}
let s: Session | null = null;
let applyingRemote = false;

/** Room names double as secrets: with a password, the real room is derived from both. */
async function roomKey(room: string, password?: string) {
  if (!password) return room;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${room}\u0000${password}`));
  return `${room}-${[...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const randomRoom = () => {
  const words = ['blue', 'night', 'jazz', 'groove', 'velvet', 'echo', 'tape', 'neon', 'soul', 'swing', 'lofi', 'funk'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 9000 + 1000)}`;
};

/** Peer-to-peer links from a studio running on this computer point to the public demo instead. */
const PUBLIC_URL = 'https://iltempe.github.io/openband/';
/** y-webrtc's default public signaling server; add your own with ?signal=wss://… (any y-webrtc signaling server). */
const PUBLIC_SIGNALING = 'wss://y-webrtc-eu.fly.dev';
const isLocalPage = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

function linkFor(room: string, via: 'lan' | 'p2p', wsBase?: string) {
  const base = via === 'lan' && wsBase ? wsBase.replace(/^ws/, 'http') : isLocalPage() ? PUBLIC_URL : `${location.origin}${location.pathname}`;
  const u = new URL(base);
  u.searchParams.set('room', room);
  u.searchParams.set('via', via);
  // Custom signaling servers travel with the link, so the others meet on the same ones.
  if (via === 'p2p') for (const sig of new URLSearchParams(location.search).getAll('signal')) u.searchParams.append('signal', sig);
  return u.toString();
}

function pushAwareness() {
  if (!s) return;
  const st = useStore.getState();
  const c = useCollab.getState();
  s.provider.awareness.setLocalStateField('user', { name: c.me.name, color: c.me.color, host: c.isHost });
  s.provider.awareness.setLocalStateField('state', {
    trackId: st.selectedTrackId,
    regionId: st.selectedRegionId,
    position: +engine.position.toFixed(2),
    playing: engine.playing,
    ai: st.bridgeStatus === 'connected',
    want: Object.keys(useSamples.getState().missing),
  });
}

function readPeers() {
  if (!s) return;
  const mine = s.doc.clientID;
  const peers: Peer[] = [];
  s.provider.awareness.getStates().forEach((v, clientId) => {
    const u = (v as { user?: { name: string; color: string; host?: boolean } }).user;
    const x = (v as { state?: Partial<Peer> & { want?: string[] } }).state ?? {};
    if (!u) return;
    peers.push({ clientId, name: u.name, color: u.color, host: !!u.host, me: clientId === mine, trackId: x.trackId, regionId: x.regionId, position: x.position, playing: x.playing, ai: x.ai });
  });
  useCollab.setState({ peers: peers.sort((a, b) => Number(b.me) - Number(a.me) || a.name.localeCompare(b.name)) });
  // Same colour as someone who was here first? Take a free one.
  const me = useCollab.getState().me;
  if (peers.some((p) => !p.me && p.color === me.color && p.clientId < mine)) {
    const free = COLORS.find((c) => !peers.some((p) => p.color === c));
    if (free) {
      useCollab.setState({ me: { ...me, color: free } });
      pushAwareness();
    }
  }
  serveSamples();
  followHost();
}

/** Peers that miss a sample ask for it in their awareness; whoever has it puts it in the doc. */
function serveSamples() {
  if (!s) return;
  const data = s.doc.getMap<{ name: string; type: string; data: Uint8Array }>('sampleData');
  const wanted = new Set<string>();
  s.provider.awareness.getStates().forEach((v, id) => {
    if (id === s!.doc.clientID) return;
    for (const w of (v as { state?: { want?: string[] } }).state?.want ?? []) wanted.add(w);
  });
  for (const id of wanted) {
    if (data.has(id)) continue;
    const stored = getStoredSample(id);
    if (!stored || stored.data.byteLength > MAX_SAMPLE) continue;
    s.doc.transact(() => data.set(id, { name: stored.name, type: stored.type, data: new Uint8Array(stored.data) }), 'samples');
  }
}

let lastHostPlaying: boolean | undefined;
function followHost() {
  const c = useCollab.getState();
  if (!c.followHost || c.isHost) return;
  const host = c.peers.find((p) => p.host && !p.me);
  if (!host || host.playing === lastHostPlaying) return;
  lastHostPlaying = host.playing;
  if (host.playing && !engine.playing) {
    engine.position = host.position ?? engine.position;
    void engine.play().then(() => useStore.getState().set({ isPlaying: true }));
  } else if (!host.playing && engine.playing) {
    engine.stop();
    useStore.getState().set({ isPlaying: false });
  }
}

function bind(session: Session) {
  const { doc } = session;
  // Remote changes → store (not in the local undo history).
  doc.on('update', (_u: Uint8Array, origin: unknown) => {
    if (origin === LOCAL || origin === 'samples') return;
    applyingRemote = true;
    try {
      const current = useStore.getState().project;
      const next = readProject(doc, current);
      if (current.meta?.projectId) next.meta = { ...(next.meta as NonNullable<Project['meta']>), projectId: next.meta?.projectId ?? current.meta.projectId };
      useStore.setState({ project: next });
    } finally {
      applyingRemote = false;
    }
  });
  // Local changes → doc.
  session.unsub.push(
    useStore.subscribe((st, prev) => {
      if (applyingRemote || st.project === prev.project) return;
      writeProject(doc, st.project, LOCAL);
    }),
  );
  // Samples arriving from a peer.
  const data = doc.getMap<{ name: string; type: string; data: Uint8Array }>('sampleData');
  data.observe((ev) => {
    for (const key of ev.keysChanged) {
      const v = data.get(key);
      if (!v || !useSamples.getState().missing[key]) continue;
      const bytes = v.data.slice().buffer;
      void importSample(bytes, v.name, v.type).then(() => doc.transact(() => data.delete(key), 'samples'));
    }
  });
  // Shared AI activity: what the AI connected to this browser does, for everyone.
  const activity = doc.getArray<RoomActivity>('activity');
  activity.observe(() => useCollab.setState({ activity: activity.toArray().slice(-50).reverse() }));
  session.unsub.push(
    useStore.subscribe((st, prev) => {
      if (st.bridgeLog === prev.bridgeLog || !st.bridgeLog.length) return;
      const e = st.bridgeLog[0];
      if (prev.bridgeLog[0]?.id === e.id) return;
      doc.transact(() => {
        activity.push([{ peer: useCollab.getState().me.name, method: e.method, summary: e.summary, at: e.time }]);
        if (activity.length > 200) activity.delete(0, activity.length - 200);
      }, 'activity');
    }),
  );
  session.unsub.push(useSamples.subscribe(() => pushAwareness()));
  session.unsub.push(useStore.subscribe((st, prev) => (st.selectedTrackId !== prev.selectedTrackId || st.selectedRegionId !== prev.selectedRegionId || st.bridgeStatus !== prev.bridgeStatus) && pushAwareness()));
  session.provider.awareness.on('change', readPeers);
}

async function makeProvider(room: string, via: 'lan' | 'p2p', doc: Y.Doc, wsBase?: string, password?: string) {
  if (via === 'lan') {
    const { WebsocketProvider } = await import('y-websocket');
    return new WebsocketProvider(`${wsBase}/collab`, room, doc) as unknown as Session['provider'];
  }
  const { WebrtcProvider } = await import('y-webrtc');
  const params = new URLSearchParams(location.search);
  // Peers meet on any signaling server they share: this computer's (if the MCP server offers one) and the public one.
  const signaling = [...params.getAll('signal'), ...(getConfig().collabServer?.signaling ?? [])];
  const server = useCollab.getState().server;
  if (server) signaling.push(`ws://127.0.0.1:${server.port}/signal`);
  signaling.push(PUBLIC_SIGNALING);
  // With a password, y-webrtc also encrypts everything sent between peers.
  return new WebrtcProvider(room, doc, { signaling: [...new Set(signaling)], ...(password ? { password } : {}) }) as unknown as Session['provider'];
}

/** The relay to use for LAN rooms: our MCP server (when started with OPENBAND_COLLAB=1). */
function lanBase(): string | undefined {
  const params = new URLSearchParams(location.search);
  if (params.get('collab')) return params.get('collab')!;
  const relay = getConfig().collabServer?.relay;
  if (relay) return relay.replace(/\/collab\/?$/, '');
  const srv = useCollab.getState().server;
  if (srv?.lan.length) return srv.lan[0].replace(/^http/, 'ws');
  // A page opened from the LAN server itself.
  if (params.get('via') === 'lan') return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  return undefined;
}

async function start(room: string, password: string | undefined, via: 'lan' | 'p2p', host: boolean) {
  if (s) leaveRoom();
  const wsBase = via === 'lan' ? lanBase() : undefined;
  if (via === 'lan' && !wsBase) throw new Error('No LAN relay: start the MCP server with OPENBAND_COLLAB=1, or use a peer-to-peer room');
  useCollab.setState({ status: 'connecting', room, via, isHost: host, link: linkFor(room, via, wsBase), activity: [] });
  const doc = new Y.Doc();
  const provider = await makeProvider(await roomKey(room, password), via, doc, wsBase, password);
  const undo = undoManagerFor(doc, LOCAL);
  const session: Session = { doc, provider, undo, unsub: [], timer: setInterval(pushAwareness, 300) };
  s = session;
  // Wait for the first sync (LAN) or a short moment for peers (P2P), then share or adopt the song.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => !done && ((done = true), resolve());
    provider.on('sync', (ok: unknown) => ok && finish());
    provider.on('synced', () => finish());
    setTimeout(finish, via === 'lan' ? 4000 : 1500);
  });
  if (s !== session) return;
  if (host || isEmptyDoc(doc)) writeProject(doc, useStore.getState().project, 'init');
  else {
    const current = useStore.getState().project;
    useStore.getState().loadProject(readProject(doc, current));
  }
  bind(session);
  setUndoOverride({ undo: () => undo.undo(), redo: () => undo.redo(), boundary: () => undo.stopCapturing() });
  useCollab.setState({ status: 'connected' });
  pushAwareness();
  readPeers();
}

export async function createRoom(o: { password?: string; via?: 'lan' | 'p2p' } = {}) {
  const via = o.via ?? (lanBase() ? 'lan' : 'p2p');
  const room = randomRoom();
  await start(room, o.password, via, true);
  return { room, via, link: useCollab.getState().link, password_protected: !!o.password };
}

export async function joinRoom(room: string, password?: string, via?: 'lan' | 'p2p') {
  const v = via ?? (new URLSearchParams(location.search).get('via') === 'lan' || lanBase() ? 'lan' : 'p2p');
  await start(room, password, v, false);
  return { room, via: v, peers: useCollab.getState().peers.length };
}

export function leaveRoom() {
  if (!s) return { left: false };
  const old = s;
  s = null;
  clearInterval(old.timer);
  old.unsub.forEach((f) => f());
  setUndoOverride(null);
  old.provider.destroy();
  old.doc.destroy();
  useCollab.setState({ room: null, via: null, status: 'off', peers: [], isHost: false, link: null, activity: [] });
  return { left: true };
}

export const getPeers = () => {
  const c = useCollab.getState();
  return {
    room: c.room,
    status: c.status,
    peers: c.peers.map((p) => ({ name: p.name, me: p.me, host: p.host, ai_connected: !!p.ai, selected_track_id: p.trackId ?? null, playing: !!p.playing, bar: p.position !== undefined ? Math.floor(p.position / 4) + 1 : null })),
  };
};
