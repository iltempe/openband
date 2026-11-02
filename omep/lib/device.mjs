// The OMEP device profile (omep/README.md §11): a sensor or instrument that joins like an engine. A device is an MCP
// server with a `device` block in its manifest and `device.*` tools. Its controls stream on the `ws-ctl` transport:
// MCP opens and closes, and JSON frames { beat, t, values } travel on a WebSocket.
//
//   const d = await createDevice({ manifest, read: () => ({ distance: 0.4 }), set: (output, value) => {} });
//   await d.serveStdio();   or   await d.serveHttp(7788);
import crypto from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocketServer } from 'ws';

export const DEVICE_EXTENSION = 'io.openband/device';
export const DEVICE_STREAM_PROTOCOL = 'omep-ctl/1.0';

/** A slow sine with a little noise: runs anywhere, and the conformance suite uses it. */
export const simulated = (now = () => performance.now()) => () => {
  const t = now() / 1000;
  return Math.max(0, Math.min(1, 0.5 + 0.45 * Math.sin(t * 2 * Math.PI * 0.2) + (Math.random() - 0.5) * 0.02));
};

export async function createDevice({ manifest, read, set = async () => {}, record, host = '127.0.0.1', token, simulate = false }) {
  const sessions = new Map();
  const wss = new WebSocketServer({ host, port: 0 });
  await new Promise((ok, fail) => {
    wss.once('listening', ok);
    wss.once('error', fail);
  });
  const url = (id) => `ws://${host}:${wss.address().port}/ctl/${id}`;
  wss.on('connection', (ws, req) => {
    const id = new URL(req.url || '/', 'http://x').pathname.split('/').pop();
    const s = sessions.get(id);
    if (!s || s.ws) return void ws.close(4404, 'Unknown or used session');
    s.ws = ws;
    ws.send(JSON.stringify({ type: 'ready', protocol: DEVICE_STREAM_PROTOCOL, rate_hz: s.rate }));
    const start = performance.now();
    let n = 0;
    s.timer = setInterval(async () => {
      if (ws.readyState !== 1) return;
      const t = (performance.now() - start) / 1000;
      ws.send(JSON.stringify({ beat: n++, t, values: await read() }));
    }, 1000 / s.rate);
    ws.on('close', () => close(id));
  });
  const close = (id) => {
    const s = sessions.get(id);
    if (!s) return false;
    clearInterval(s.timer);
    s.ws?.close();
    sessions.delete(id);
    return true;
  };
  const prov = () => ({ provenance: { engine: manifest.engine.id, engine_version: manifest.engine.version, model: manifest.device.hardware }, claims: { ...(simulate ? { simulated: true } : {}) } });
  const maxRate = manifest.capabilities['device.stream']?.max_rate_hz ?? 100;

  const build = () => {
    const server = new McpServer({ name: manifest.engine.id, version: manifest.engine.version }, { capabilities: { experimental: { [DEVICE_EXTENSION]: { version: '0.1' } } } });
    server.registerResource('manifest', 'omep://manifest', { title: 'OMEP manifest', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(manifest) }] }));
    const input = { context: z.union([z.looseObject({}), z.string()]).describe('Song Context Package, ignored by most devices'), request: z.looseObject({}).optional() };
    const answer = (c, text) => ({ content: [{ type: 'text', text }], structuredContent: c });
    server.registerTool('device.read', { title: 'device.read', description: 'A snapshot of the controls', inputSchema: input }, async () => {
      const values = await read();
      return answer({ kind: 'params', params: { values }, ...prov() }, JSON.stringify(values));
    });
    server.registerTool('device.stream', { title: 'device.stream', description: 'Open ({action:"open", rate_hz}) or close ({action:"close", session}) the stream of controls', inputSchema: input }, async ({ request = {} }) => {
      if (request.action === 'close') return answer({ kind: 'stream', stream: { transport: 'ws-ctl', url: '', session: String(request.session ?? ''), closed: close(String(request.session ?? '')) }, ...prov() }, 'closed');
      const rate = Math.min(maxRate, Number(request.rate_hz) || 50);
      const id = crypto.randomBytes(12).toString('hex');
      sessions.set(id, { rate });
      return answer({ kind: 'stream', stream: { transport: 'ws-ctl', url: url(id), protocol: DEVICE_STREAM_PROTOCOL, session: id, rate_hz: rate }, ...prov() }, url(id));
    });
    if (manifest.capabilities['device.set'])
      server.registerTool('device.set', { title: 'device.set', description: 'Drive an output: { output, value }', inputSchema: input }, async ({ request = {} }) => {
        if (!manifest.device.outputs?.some((o) => o.id === request.output)) return { isError: true, content: [{ type: 'text', text: `No output "${request.output}"` }] };
        await set(String(request.output), Number(request.value));
        return answer({ kind: 'params', params: { ack: true, output: request.output }, ...prov() }, 'ok');
      });
    if (manifest.capabilities['device.record'] && record)
      server.registerTool('device.record', { title: 'device.record', description: 'Record the controls for { seconds }', inputSchema: input }, async ({ request = {} }) => answer({ ...(await record(Math.min(Number(request.seconds) || 4, manifest.capabilities['device.record'].max_seconds ?? 600))), ...prov() }, 'recorded'));
    return server;
  };

  return {
    close: () => {
      for (const id of sessions.keys()) close(id);
      wss.close();
    },
    serveStdio: () => build().connect(new StdioServerTransport()),
    /** Streamable HTTP for the LAN; with a token, only who has it gets in. */
    serveHttp: (port) =>
      new Promise((resolve) => {
        const srv = http.createServer(async (req, res) => {
          if (token && req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
          const server = build();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await server.connect(transport);
          await transport.handleRequest(req, res);
        });
        srv.listen(port, '0.0.0.0', () => resolve(srv));
      }),
  };
}
