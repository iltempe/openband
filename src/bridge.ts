// WebSocket link to the MCP server on this computer (server/mcp-server.mjs).
// The MCP server forwards each tool call as {type:"call"} and waits for our {type:"result"}.
import { create } from 'zustand';
import { useStore } from './store';
import { runCommand } from './commands';
import { engine } from './audio/engine';
import { emitSelection, emitStudioEvent, setEventSink } from './events';
import { setCollabServer } from './collab/session';
import { protocolProblem } from './protocol';

// (Guarded so the module can be imported in Node tests.)
const loc = typeof location !== 'undefined' ? location : ({ search: '', hostname: 'localhost', host: 'localhost', protocol: 'http:' } as Location);
const params = new URLSearchParams(loc.search);
const IS_LOCAL_PAGE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname);

/** The bridge protocol this app speaks (the server says its own in hello). */
export const PROTOCOL = 1;

/**
 * Local pages (served by `npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz`, the .mcpb or `npm run dev`) connect by themselves, as always.
 * The online demo connects only when the user asks ("Connect AI"), and pairs with the code the server shows.
 */
export const BRIDGE_ENABLED = IS_LOCAL_PAGE || params.has('mcp');
const TOKEN_KEY = 'openband.bridgeToken';
const PORT_KEY = 'openband.bridgePort';

export type BridgeProblem =
  /** Nothing answered; `permission` when the browser reports Local Network Access as blocked (a possible cause). */
  | { kind: 'unreachable'; port: number; permission?: boolean }
  | { kind: 'code'; reason: 'wrong' | 'expired' | 'locked' | 'missing'; attemptsLeft?: number; retryInMs?: number }
  | { kind: 'protocol'; server: number; app: number; version?: string };

/** Connection details for the AI panel (the store keeps the plain status). */
export interface ServerUpdate {
  current: string;
  latest: string;
  update_available: boolean;
}

/** Remote MCP (a self-hosted OpenBand with /mcp): the code the AI pairs with, and whether it did. */
export interface RemoteMcpState {
  code: string | null;
  expiresAt: number | null;
  paired: boolean;
}

export const useBridge = create<{ port: number; remote: boolean; pairing: boolean; problem: BridgeProblem | null; serverVersion: string | null; update: ServerUpdate | null; remoteMcp: RemoteMcpState | null }>(() => ({
  // A page served by the OpenBand server talks to that same server (whatever free port it got);
  // Vite's dev server (5173) and the online demo default to 7777.
  port: Number(params.get('mcp') ?? (IS_LOCAL_PAGE && loc.port && loc.port !== '5173' ? loc.port : null) ?? sessionGet(PORT_KEY) ?? 7777),
  remote: !IS_LOCAL_PAGE,
  pairing: false,
  problem: null,
  serverVersion: null,
  update: null,
  remoteMcp: null,
}));

function sessionGet(k: string) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function sessionSet(k: string, v: string | null) {
  try {
    if (v === null) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, v);
  } catch {
    // not kept
  }
}

/** Set by startRemoteMcp(): talk to the server that served this page and pair with an MCP session. */
let remoteMcpMode = false;
export const bridgeUrl = (port = useBridge.getState().port) => (remoteMcpMode ? sameOriginBridgeUrl() : `ws://127.0.0.1:${port}/bridge`);
/** The server that served this page (remote MCP mode). */
export const sameOriginBridgeUrl = (l: Pick<Location, 'protocol' | 'host'> = loc) => `${l.protocol === 'https:' ? 'wss' : 'ws'}://${l.host}/bridge`;
/** The connector URL to paste into claude.ai (the server's /mcp next to this page). */
export const remoteMcpUrl = (l: Pick<Location, 'protocol' | 'host'> = loc) => `${l.protocol}//${l.host}/mcp`;
/** Kept for the setup text in the AI panel. */
export const BRIDGE_URL = bridgeUrl();

let socket: WebSocket | null = null;
let retry = 1000;
let pendingCode: string | null = null;
let wanted = false;

/** Chrome's "Local Network Access" permission, when the browser knows it. */
async function lnaDenied(): Promise<boolean> {
  try {
    const st = await navigator.permissions.query({ name: 'local-network-access' as PermissionName });
    return st.state === 'denied';
  } catch {
    return false;
  }
}

/** Online demo: connect to the server on `port` and pair with `code` (or with the token of this tab). */
export function connectRemote(port: number, code?: string) {
  useBridge.setState({ port, problem: null });
  sessionSet(PORT_KEY, String(port));
  pendingCode = code ? code.replace(/\D/g, '') : null;
  wanted = true;
  socket?.close();
  connectBridge();
}

/**
 * Remote MCP: connect this tab to the server it came from and get a 6-digit code; the AI (claude.ai,
 * through the /mcp connector) pairs with it and from then on drives only this tab.
 */
export function startRemoteMcp() {
  if (remoteMcpMode && socket && socket.readyState <= 1) return;
  remoteMcpMode = true;
  wanted = true;
  // A local page may have a reconnect pending for its normal bridge: it must not open a second
  // (remote) connection later, which would get a new code while this one is paired.
  clearTimeout(reconnectTimer);
  useBridge.setState({ remoteMcp: { code: null, expiresAt: null, paired: false }, problem: null });
  socket?.close();
  connectBridge();
}

export function disconnectBridge() {
  wanted = false;
  if (remoteMcpMode) {
    remoteMcpMode = false;
    useBridge.setState({ remoteMcp: null });
  }
  sessionSet(TOKEN_KEY, null);
  socket?.close();
}

export function connectBridge() {
  const set = useStore.getState().set;
  // One connection at a time in remote MCP mode (a stray retry must not replace the paired one).
  if (remoteMcpMode && socket && socket.readyState <= 1 && socket.url === sameOriginBridgeUrl()) return;
  const remote = !BRIDGE_ENABLED && !remoteMcpMode;
  const viaMcp = remoteMcpMode;
  // The demo stays offline until the user asks — unless this tab already paired.
  if (remote && !wanted && !sessionGet(TOKEN_KEY)) {
    set({ bridgeStatus: 'disconnected' });
    return;
  }
  wanted = true;
  set({ bridgeStatus: 'connecting' });
  const port = useBridge.getState().port;
  let opened = false;
  try {
    socket = new WebSocket(bridgeUrl(port));
  } catch {
    if (remote) return void fail({ kind: 'unreachable', port });
    scheduleReconnect();
    return;
  }
  if (viaMcp) set({ bridgeStatus: 'disconnected' });
  const ws = socket;
  const send = (m: unknown) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  ws.onopen = () => {
    opened = true;
    retry = 1000;
    send({ type: 'hello', app: 'openband', protocol: PROTOCOL, ...(viaMcp ? { remote: true } : {}), ...(remote ? { token: sessionGet(TOKEN_KEY) ?? undefined, pair: pendingCode ?? undefined } : {}) });
  };
  ws.onmessage = async (ev) => {
    let msg: { type: string; id: string; method: string; params: Record<string, unknown>; collab?: { lan: string[]; port: number } | null; protocol?: number; update?: ServerUpdate | null; version?: string; token?: string; reason?: 'wrong' | 'expired' | 'locked' | 'missing'; attempts_left?: number; retry_in_ms?: number; remote?: boolean; code?: string; expires_in_ms?: number };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'remote_code') return void useBridge.setState({ remoteMcp: { code: msg.code ?? null, expiresAt: Date.now() + (msg.expires_in_ms ?? 600000), paired: false } });
    if (msg.type === 'remote_paired') return void useBridge.setState({ remoteMcp: { code: null, expiresAt: null, paired: true } });
    // A local page switching to remote MCP gets the usual hello first: only the remote one counts.
    if (viaMcp && msg.type === 'hello' && !msg.remote) return;
    if (msg.type === 'pair_required') {
      // The token was refused (server restarted) or no code yet: ask for one.
      sessionSet(TOKEN_KEY, null);
      if (pendingCode) return;
      useBridge.setState({ pairing: true });
      set({ bridgeStatus: 'disconnected' });
      return;
    }
    if (msg.type === 'pair_failed') {
      pendingCode = null;
      useBridge.setState({ pairing: true, problem: { kind: 'code', reason: msg.reason ?? 'wrong', attemptsLeft: msg.attempts_left, retryInMs: msg.retry_in_ms } });
      set({ bridgeStatus: 'disconnected' });
      return;
    }
    if (msg.type === 'update') return void useBridge.setState({ update: msg.update ?? null });
    if (msg.type === 'paired') {
      pendingCode = null;
      if (msg.token) sessionSet(TOKEN_KEY, msg.token);
      return;
    }
    if (msg.type === 'hello') {
      setCollabServer(msg.collab ?? null);
      const mismatch = protocolProblem(msg.protocol, PROTOCOL);
      useBridge.setState({ pairing: false, problem: mismatch ? { kind: 'protocol', server: msg.protocol!, app: PROTOCOL, version: msg.version } : null, serverVersion: msg.version ?? null, update: msg.update ?? null });
      set({ bridgeStatus: 'connected' });
      setEventSink({
        event: (event) => send({ type: 'event', event }),
        projectChanged: () => send({ type: 'project_changed' }),
      });
      return;
    }
    if (msg.type !== 'call') return;
    try {
      const result = await runCommand(msg.method, msg.params, 'ai');
      send({ type: 'result', id: msg.id, ok: true, result: result ?? null });
    } catch (e) {
      send({ type: 'result', id: msg.id, ok: false, error: (e as Error).message });
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    setEventSink(null);
    set({ bridgeStatus: 'disconnected' });
    if (viaMcp) {
      // A new connection means a new code: the AI has to pair again.
      if (remoteMcpMode) useBridge.setState({ remoteMcp: { code: null, expiresAt: null, paired: false } });
      if (remoteMcpMode && wanted) scheduleReconnect();
      return;
    }
    if (!remote) return void scheduleReconnect();
    // The demo: say why, instead of retrying blindly.
    if (!opened) void lnaDenied().then((denied) => fail({ kind: 'unreachable', port, permission: denied }));
    else if (wanted && sessionGet(TOKEN_KEY) && !useBridge.getState().pairing) scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function fail(problem: BridgeProblem) {
  useBridge.setState({ problem });
  useStore.getState().set({ bridgeStatus: 'disconnected' });
}

// What the user does with the transport and the selection, for the AI (see events.ts).
const bar = () => Math.floor(engine.position / 4) + 1;
useStore.subscribe((s, prev) => {
  if (s.isPlaying !== prev.isPlaying) emitStudioEvent({ kind: 'transport', action: s.isPlaying ? 'play' : 'stop', bar: bar() });
  if (s.project.loop.enabled !== prev.project.loop.enabled && s.project.loop.enabled) emitStudioEvent({ kind: 'transport', action: 'loop', bar: s.project.loop.start / 4 + 1 });
  if (s.selectedTrackId !== prev.selectedTrackId || s.selectedRegionId !== prev.selectedRegionId || (s.selectedNoteIds !== prev.selectedNoteIds && (s.selectedNoteIds.length > 0 || prev.selectedNoteIds.length > 0))) {
    emitSelection({
      kind: 'selection',
      ...(s.selectedTrackId ? { track_id: s.selectedTrackId } : {}),
      ...(s.selectedRegionId ? { region_id: s.selectedRegionId } : {}),
      ...(s.selectedNoteIds.length ? { note_ids: s.selectedNoteIds } : {}),
    });
  }
});

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBridge, retry);
  retry = Math.min(retry * 1.6, 8000);
}
