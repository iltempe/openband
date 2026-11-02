// The library on disk (R1), apart from the main process: it fsyncs, and the main process carries the native
// plugins' calls, which must never wait for a disk.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OPENBAND_ROOT || here;
const load = (...f) => import(pathToFileURL(path.join(ROOT, 'server', ...f)).href);
const [{ FsStore }, { createStoreApi }, { Pairing }] = await Promise.all([load('store', 'fs.mjs'), load('store', 'api.mjs'), load('pairing.mjs')]);

const api = createStoreApi({ store: new FsStore({ dir: process.env.OPENBAND_DATA }), pairing: new Pairing(), own: true });
const wss = new WebSocketServer({ noServer: true });
const srv = http.createServer(async (req, res) => {
  if (!(await api.handleHttp(req, res))) res.writeHead(404).end();
});
srv.on('upgrade', (req, socket, head) => (api.handles(new URL(req.url || '/', 'http://x').pathname) ? api.upgrade(wss, req, socket, head) : socket.destroy()));
srv.listen(0, '127.0.0.1', () => process.parentPort.postMessage({ port: srv.address().port }));
