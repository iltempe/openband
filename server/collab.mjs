// Optional collaboration endpoints for the LAN (OPENBAND_COLLAB=1):
//   /collab/<room>  a relay compatible with y-websocket clients (one shared Y.Doc + awareness per room)
//   /signal         a signaling server for y-webrtc (JSON pub/sub), for peer-to-peer rooms
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocketServer } from 'ws';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MAX_ROOMS = 200;

/** @type {Map<string, { doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Map<import('ws').WebSocket, Set<number>> }>} */
const rooms = new Map();

function room(name) {
  let r = rooms.get(name);
  if (r) return r;
  if (rooms.size >= MAX_ROOMS) throw new Error('too many rooms');
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  r = { doc, awareness, conns: new Map() };
  doc.on('update', (update, origin) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const c of r.conns.keys()) if (c !== origin) send(c, msg);
  });
  awareness.on('update', ({ added, updated, removed }, origin) => {
    const changed = [...added, ...updated, ...removed];
    if (origin && r.conns.has(origin)) {
      const ids = r.conns.get(origin);
      added.forEach((id) => ids.add(id));
      removed.forEach((id) => ids.delete(id));
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    const msg = encoding.toUint8Array(enc);
    for (const c of r.conns.keys()) send(c, msg);
  });
  rooms.set(name, r);
  return r;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(msg, (err) => err && ws.close());
}

function onCollab(ws, name) {
  let r;
  try {
    r = room(name);
  } catch {
    return ws.close();
  }
  r.conns.set(ws, new Set());
  ws.binaryType = 'arraybuffer';
  ws.on('message', (data) => {
    try {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, r.doc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(r.awareness, decoding.readVarUint8Array(dec), ws);
      }
    } catch {
      // ignore malformed messages
    }
  });
  ws.on('close', () => {
    const ids = r.conns.get(ws);
    r.conns.delete(ws);
    if (ids?.size) awarenessProtocol.removeAwarenessStates(r.awareness, [...ids], null);
    // Rooms live while someone is in them.
    if (!r.conns.size) {
      r.doc.destroy();
      rooms.delete(name);
    }
  });
  // Start the sync and send who's here.
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, r.doc);
  send(ws, encoding.toUint8Array(enc));
  const states = [...r.awareness.getStates().keys()];
  if (states.length) {
    const a = encoding.createEncoder();
    encoding.writeVarUint(a, MSG_AWARENESS);
    encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(r.awareness, states));
    send(ws, encoding.toUint8Array(a));
  }
}

/** y-webrtc signaling: subscribe / unsubscribe / publish / ping. */
const topics = new Map();
function onSignal(ws) {
  const mine = new Set();
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m?.type === 'subscribe') for (const t of m.topics ?? []) {
      if (typeof t !== 'string') continue;
      if (!topics.has(t)) topics.set(t, new Set());
      topics.get(t).add(ws);
      mine.add(t);
    }
    else if (m?.type === 'unsubscribe') for (const t of m.topics ?? []) {
      topics.get(t)?.delete(ws);
      mine.delete(t);
    }
    else if (m?.type === 'publish' && typeof m.topic === 'string') {
      const subs = topics.get(m.topic);
      if (!subs) return;
      m.clients = subs.size;
      const out = JSON.stringify(m);
      for (const c of subs) if (c.readyState === 1) c.send(out);
    } else if (m?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  });
  ws.on('close', () => {
    for (const t of mine) {
      topics.get(t)?.delete(ws);
      if (!topics.get(t)?.size) topics.delete(t);
    }
  });
}

/** Route /collab/<room> and /signal upgrades; returns false for other paths. */
export function createCollab() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  return {
    handles: (pathname) => pathname.startsWith('/collab/') || pathname === '/signal',
    upgrade(req, socket, head, pathname) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (pathname === '/signal') onSignal(ws);
        else onCollab(ws, decodeURIComponent(pathname.slice('/collab/'.length)).slice(0, 200));
      });
    },
    rooms: () => [...rooms.entries()].map(([name, r]) => ({ name, peers: r.awareness.getStates().size })),
  };
}
