// WebSocket link to the local MCP server (server/mcp-server.mjs).
// The MCP server forwards each tool call as {type:"call"} and waits for our {type:"result"}.
import { useStore } from './store';
import { runCommand } from './commands';
import { engine } from './audio/engine';
import { emitSelection, emitStudioEvent, setEventSink } from './events';
import { setCollabServer } from './collab/session';

const params = new URLSearchParams(location.search);
const port = params.get('mcp') ?? '7777';
export const BRIDGE_URL = `ws://127.0.0.1:${port}/bridge`;

// The MCP server only accepts pages served from localhost, so the hosted demo (GitHub Pages)
// skips the bridge instead of retrying forever.
export const BRIDGE_ENABLED = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || params.has('mcp');

let socket: WebSocket | null = null;
let retry = 1000;

export function connectBridge() {
  const set = useStore.getState().set;
  if (!BRIDGE_ENABLED) {
    set({ bridgeStatus: 'disconnected' });
    return;
  }
  set({ bridgeStatus: 'connecting' });
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    retry = 1000;
    set({ bridgeStatus: 'connected' });
    const ws = socket!;
    setEventSink({
      event: (event) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'event', event })),
      projectChanged: () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'project_changed' })),
    });
    socket?.send(JSON.stringify({ type: 'hello', app: 'openband', version: '0.1.0' }));
  };
  socket.onmessage = async (ev) => {
    let msg: { type: string; id: string; method: string; params: Record<string, unknown>; collab?: { lan: string[]; port: number } | null };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') return void setCollabServer(msg.collab ?? null);
    if (msg.type !== 'call') return;
    try {
      const result = await runCommand(msg.method, msg.params, 'ai');
      socket?.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: result ?? null }));
    } catch (e) {
      socket?.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: (e as Error).message }));
    }
  };
  socket.onclose = () => {
    setEventSink(null);
    set({ bridgeStatus: 'disconnected' });
    scheduleReconnect();
  };
  socket.onerror = () => socket?.close();
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

function scheduleReconnect() {
  setTimeout(connectBridge, retry);
  retry = Math.min(retry * 1.6, 8000);
}
