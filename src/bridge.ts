// WebSocket link to the local MCP server (server/mcp-server.mjs).
// The MCP server forwards each tool call as {type:"call"} and waits for our {type:"result"}.
import { useStore } from './store';
import { runCommand } from './commands';

const port = new URLSearchParams(location.search).get('mcp') ?? '7777';
export const BRIDGE_URL = `ws://127.0.0.1:${port}/bridge`;

let socket: WebSocket | null = null;
let retry = 1000;

export function connectBridge() {
  const set = useStore.getState().set;
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
    socket?.send(JSON.stringify({ type: 'hello', app: 'openband', version: '0.1.0' }));
  };
  socket.onmessage = async (ev) => {
    let msg: { type: string; id: string; method: string; params: Record<string, unknown> };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type !== 'call') return;
    try {
      const result = await runCommand(msg.method, msg.params, 'ai');
      socket?.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: result ?? null }));
    } catch (e) {
      socket?.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: (e as Error).message }));
    }
  };
  socket.onclose = () => {
    set({ bridgeStatus: 'disconnected' });
    scheduleReconnect();
  };
  socket.onerror = () => socket?.close();
}

function scheduleReconnect() {
  setTimeout(connectBridge, retry);
  retry = Math.min(retry * 1.6, 8000);
}
