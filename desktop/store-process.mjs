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
// Rehearsal mode (R2.8): the same recorder as `openband box`, while the app is open.
let stopBox = null;
process.parentPort.on('message', async ({ data }) => {
  if (data?.rehearsal === undefined) return;
  stopBox?.();
  stopBox = null;
  api.box = null;
  if (!data.rehearsal) return;
  const [{ Box, startRecording }, { readBox }] = await Promise.all([load('box', 'run.mjs'), load('box', 'config.mjs')]);
  const dir = path.join(path.dirname(process.env.OPENBAND_DATA), 'box');
  const cfg = readBox(dir);
  const box = new Box({ dir, cfg, store: api.store, emit: api.emit, log: console.error });
  box.recover();
  api.box = box;
  stopBox = startRecording(box, cfg);
});

srv.listen(0, '127.0.0.1', () => process.parentPort.postMessage({ port: srv.address().port }));
