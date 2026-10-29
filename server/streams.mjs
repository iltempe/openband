// Real-time streams from OMEP engines (stream.jam, SPEC v0.6 §2.5) to the page, through this server: the
// page asks over the bridge (`engine` op `stream_open`), the engine host opens a session with the engine's
// `stream.jam` tool, and the page connects to ws://127.0.0.1:<port>/stream/<id> — an id it got only over
// the bridge, valid once, for 60 s. Frames and clock messages are piped both ways untouched, so the page
// never needs to reach an engine on the LAN itself (nor know its token), and closing either end closes both.
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

export class StreamRelay {
  constructor({ engines, log = () => {} }) {
    this.engines = engines;
    this.log = log;
    /** id → { engine, session, url, opened, page, upstream } */
    this.relays = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  }

  handles(pathname) {
    return /^\/stream\/[a-f0-9]{32}$/.test(pathname);
  }

  /** Open a stream on an engine: its descriptor, and where the page connects. */
  async open(engine, args) {
    const c = await this.engines.call(engine, 'stream.jam', { ...args, request: { ...(args.request ?? {}), action: 'open' } }, { timeoutMs: 120000 });
    if (c.kind !== 'stream' || !c.stream?.url) throw new Error(`${engine} did not open a stream`);
    if (c.stream.transport !== 'ws-pcm') throw new Error(`${engine} streams ${c.stream.transport}: OpenBand plays ws-pcm`);
    const id = crypto.randomBytes(16).toString('hex');
    this.relays.set(id, { engine, session: c.stream.session, url: c.stream.url, opened: Date.now(), page: null, upstream: null });
    setTimeout(() => {
      const r = this.relays.get(id);
      if (r && !r.page) void this.close(id);
    }, 60000).unref?.();
    this.log(`stream ${id.slice(0, 8)} from ${engine}`);
    return { relay: id, path: `/stream/${id}`, stream: c.stream, provenance: c.provenance, license: c.license };
  }

  upgrade(req, socket, head, pathname) {
    const id = pathname.split('/').pop();
    const r = this.relays.get(id);
    if (!r || r.page) return void socket.destroy();
    this.wss.handleUpgrade(req, socket, head, (page) => {
      r.page = page;
      const up = new WebSocket(r.url);
      r.upstream = up;
      const queue = [];
      up.on('open', () => {
        for (const [d, b] of queue.splice(0)) up.send(d, { binary: b });
      });
      up.on('message', (data, binary) => page.readyState === 1 && page.send(data, { binary }));
      page.on('message', (data, binary) => (up.readyState === 1 ? up.send(data, { binary }) : queue.length < 100 && queue.push([data, binary])));
      const end = (why) => () => {
        if (page.readyState <= 1) page.close(1000, why);
        if (up.readyState <= 1) up.close(1000, why);
        void this.close(id);
      };
      up.on('close', end('engine closed'));
      up.on('error', (e) => {
        if (page.readyState === 1) page.send(JSON.stringify({ type: 'error', message: `Engine stream: ${e.message}` }));
        end('engine error')();
      });
      page.on('close', end('page closed'));
    });
  }

  /** Close a relay and the engine's session. */
  async close(id) {
    const r = this.relays.get(id);
    if (!r) return false;
    this.relays.delete(id);
    r.page?.close();
    r.upstream?.close();
    if (r.session) await this.engines.call(r.engine, 'stream.jam', { context: {}, request: { action: 'close', session: r.session } }, { timeoutMs: 10000 }).catch(() => {});
    return true;
  }

  async closeAll() {
    await Promise.all([...this.relays.keys()].map((id) => this.close(id)));
  }
}
