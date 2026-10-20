#!/usr/bin/env node
// F26 spike: the WebView ↔ native audio bridge, measured. A page (Chrome here; the WebView in an app)
// sends 128-frame stereo blocks from an AudioWorklet over a local WebSocket; this relay pipes them to
// the native CLAP host (`clap-host --serve`), which runs them through the plugin and sends them back.
//   node bridge.mjs <clap-host binary> <plugin.clap> [port]     then open http://127.0.0.1:<port>/
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const [hostBin, plugin, portArg] = process.argv.slice(2);
const PORT = Number(portArg ?? 7811);
const BLOCK_BYTES = 4 + 2 * 128 * 4;

const PAGE = `<!doctype html><meta charset="utf-8"><title>bridge</title><body>
<script>
const WORKLET = \`
class Bridge extends AudioWorkletProcessor {
  constructor() {
    super(); this.seq = 0; this.sent = new Map(); this.rtt = []; this.inbox = [];
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'report') { this.port.postMessage({ rtt: this.rtt }); return; }
      const t = this.sent.get(e.data.seq); if (t !== undefined) { this.rtt.push(currentFrame - t); this.sent.delete(e.data.seq); }
    };
  }
  process(inputs, outputs) {
    // One block per render quantum: a sine in, timestamped in frames (audio time).
    const b = new Float32Array(256); for (let i = 0; i < 128; i++) b[i] = b[128 + i] = Math.sin((currentFrame + i) * 0.05) * 0.3;
    const seq = this.seq++; this.sent.set(seq, currentFrame);
    this.port.postMessage({ seq, b }, [b.buffer]);
    return true;
  }
}
registerProcessor('bridge', Bridge);\`;
(async () => {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  const node = new AudioWorkletNode(ctx, 'bridge'); node.connect(ctx.destination);
  const ws = new WebSocket('ws://' + location.host + '/audio'); ws.binaryType = 'arraybuffer';
  await new Promise((r) => (ws.onopen = r));
  // worklet → main thread → WebSocket → native → back → worklet
  node.port.onmessage = (e) => {
    if (e.data.rtt) { window.result = { rtt: e.data.rtt, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency }; return; }
    const buf = new ArrayBuffer(4 + 1024); new DataView(buf).setUint32(0, e.data.seq, true); new Float32Array(buf, 4).set(e.data.b);
    ws.send(buf);
  };
  ws.onmessage = (e) => node.port.postMessage({ seq: new DataView(e.data).getUint32(0, true) });
  await ctx.resume();
  window.ready = true;
  window.report = () => node.port.postMessage({ cmd: 'report' });
})();
</script>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
const wss = new WebSocketServer({ server, path: '/audio' });
wss.on('connection', (ws) => {
  const native = spawn(hostBin, [plugin, '--serve', '0'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let pending = Buffer.alloc(0);
  native.stdout.on('data', (d) => {
    pending = Buffer.concat([pending, d]);
    while (pending.length >= BLOCK_BYTES) {
      ws.send(pending.subarray(0, BLOCK_BYTES));
      pending = pending.subarray(BLOCK_BYTES);
    }
  });
  // The page sends seq (u32) + 256 floats: the native protocol is the same layout (header, L, R).
  ws.on('message', (m) => native.stdin.write(m));
  ws.on('close', () => native.kill());
});
server.listen(PORT, '127.0.0.1', () => console.error(`bridge on http://127.0.0.1:${PORT}/`));
