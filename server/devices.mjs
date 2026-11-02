// Devices (R3): the server is their host, as for engines. The page never reaches one directly: it asks over the
// bridge, and the controls come back through here.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';

export class DeviceHost {
  constructor({ onFrame = () => {}, log = () => {} } = {}) {
    Object.assign(this, { onFrame, log });
    /** id → { client, manifest, url, ws, session, latencyMs } */
    this.live = new Map();
  }

  async connect({ url, token }) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('A device address is http(s)://host:port');
    const client = new Client({ name: 'openband-devices', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(parsed, token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}));
    const caps = client.getServerCapabilities() ?? {};
    if (!caps.experimental?.['io.openband/device']) {
      await client.close().catch(() => {});
      throw new Error('That server is not an OMEP device');
    }
    const res = await client.readResource({ uri: 'omep://manifest' });
    const manifest = JSON.parse(res.contents[0].text);
    if (!manifest.device) throw new Error('Its manifest has no device block');
    const id = manifest.engine.id;
    await this.drop(id);
    this.live.set(id, { client, manifest, url });
    return this.describe(id);
  }

  describe(id) {
    const d = this.live.get(id);
    return { id, name: d.manifest.engine.name, hardware: d.manifest.device.hardware, controls: d.manifest.device.controls, outputs: d.manifest.device.outputs ?? [], latency_ms: d.latencyMs ?? null, streaming: !!d.ws, manifest_hash: d.manifest.engine.version };
  }

  list = () => [...this.live.keys()].map((id) => this.describe(id));

  need(id) {
    const d = this.live.get(id);
    if (!d) throw new Error(`Device "${id}" is not connected. Call list_devices.`);
    return d;
  }

  async call(id, name, request) {
    const r = await this.need(id).client.callTool({ name, arguments: { context: {}, request } });
    if (r.isError) throw new Error(r.content?.[0]?.text ?? 'Device error');
    return r.structuredContent;
  }

  async read(id) {
    const t0 = performance.now();
    const c = await this.call(id, 'device.read');
    this.need(id).latencyMs = Math.round(performance.now() - t0);
    return c.params.values;
  }

  set = (id, output, value) => this.call(id, 'device.set', { output, value });

  /** Frames go to onFrame, trimmed to what the page can use. */
  async watch(id, rateHz = 50) {
    const d = this.need(id);
    if (d.ws) return this.describe(id);
    await this.read(id);
    const { stream } = await this.call(id, 'device.stream', { action: 'open', rate_hz: rateHz });
    const ws = new WebSocket(stream.url);
    d.ws = ws;
    d.session = stream.session;
    ws.on('message', (m) => {
      const f = JSON.parse(String(m));
      if (f.values) this.onFrame(id, f);
    });
    ws.on('close', () => d.ws === ws && (d.ws = null));
    ws.on('error', (e) => this.log(`device ${id}: ${e.message}`));
    return this.describe(id);
  }

  async unwatch(id) {
    const d = this.need(id);
    const s = d.session;
    d.ws?.close();
    d.ws = null;
    if (s) await this.call(id, 'device.stream', { action: 'close', session: s }).catch(() => {});
  }

  async drop(id) {
    const d = this.live.get(id);
    if (!d) return;
    d.ws?.close();
    await d.client.close().catch(() => {});
    this.live.delete(id);
  }
}
